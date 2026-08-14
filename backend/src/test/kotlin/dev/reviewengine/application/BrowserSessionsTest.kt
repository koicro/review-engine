package dev.reviewengine.application

import dev.reviewengine.domain.DomainErrorCode
import dev.reviewengine.domain.DomainException
import dev.reviewengine.persistence.Database
import dev.reviewengine.persistence.WebSessionRepository
import dev.reviewengine.persistence.instant
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.ZoneOffset
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject

class BrowserSessionsTest {
    @Test
    fun `admin session persists only fingerprints and follows configured token rotation`() {
        withEngine { database, engine, clock ->
            val session = engine.issueBrowserSession(ADMIN_TOKEN, ADMIN_TOKEN, Duration.ofHours(12))

            database.read { connection ->
                connection.createStatement().use { statement ->
                    statement.executeQuery(
                        "SELECT session_hash, identity_kind, credential_hash, expires_at FROM web_session",
                    ).use { result ->
                        assertTrue(result.next())
                        assertEquals(64, result.getString("session_hash").length)
                        assertEquals("admin", result.getString("identity_kind"))
                        assertEquals(hashToken(ADMIN_TOKEN), result.getString("credential_hash"))
                        assertNotEquals(session.rawId, result.getString("session_hash"))
                        assertFalse(result.getString("session_hash").contains(session.rawId))
                        assertEquals(clock.instant().plus(Duration.ofHours(12)), result.instant("expires_at"))
                        assertFalse(result.next())
                    }
                }
            }

            assertTrue(engine.isBrowserSessionActive(session.rawId, ADMIN_TOKEN))
            assertFalse(engine.isBrowserSessionActive(session.rawId, "rotated-administrator-token"))
        }
    }

    @Test
    fun `access token revocation immediately invalidates its browser sessions`() {
        withEngine { _, engine, _ ->
            val token = engine.issueAccessToken("Browser")
            val session = engine.issueBrowserSession(token.token, ADMIN_TOKEN, Duration.ofHours(12))
            assertTrue(engine.isBrowserSessionActive(session.rawId, ADMIN_TOKEN))

            engine.revokeAccessToken(token.record.id)
            assertFalse(engine.isBrowserSessionActive(session.rawId, ADMIN_TOKEN))
        }
    }

    @Test
    fun `expiry logout and invalid credentials fail closed`() {
        val clock = MutableClock(Instant.parse("2026-08-14T00:00:00Z"))
        Database("jdbc:sqlite::memory:").use { database ->
            database.migrate()
            val engine = ReviewEngine(database, clock)
            val unauthorized = assertFailsWith<DomainException> {
                engine.issueBrowserSession("not-a-real-credential", ADMIN_TOKEN, Duration.ofHours(1))
            }
            assertEquals(DomainErrorCode.UNAUTHORIZED, unauthorized.code)
            assertEquals(0, countSessions(database))

            val invalidLifetime = assertFailsWith<DomainException> {
                engine.issueBrowserSession(ADMIN_TOKEN, ADMIN_TOKEN, Duration.ZERO)
            }
            assertEquals(DomainErrorCode.INVALID_ARGUMENT, invalidLifetime.code)

            val expired = engine.issueBrowserSession(ADMIN_TOKEN, ADMIN_TOKEN, Duration.ofSeconds(1))
            clock.advance(Duration.ofSeconds(1))
            assertFalse(engine.isBrowserSessionActive(expired.rawId, ADMIN_TOKEN))

            val logout = engine.issueBrowserSession(ADMIN_TOKEN, ADMIN_TOKEN, Duration.ofHours(1))
            assertTrue(engine.revokeBrowserSession(logout.rawId))
            assertFalse(engine.revokeBrowserSession(logout.rawId))
            assertFalse(engine.isBrowserSessionActive(logout.rawId, ADMIN_TOKEN))
        }
    }

    @Test
    fun `successful import clears sessions but excludes them from portable data`() {
        withEngine { sourceDatabase, source, _ ->
            val session = source.issueBrowserSession(ADMIN_TOKEN, ADMIN_TOKEN, Duration.ofHours(12))
            val exported = source.exportJson()
            assertFalse("web_session" in exported.getValue("data").jsonObject)
            assertTrue(source.isBrowserSessionActive(session.rawId, ADMIN_TOKEN))
            val invalidExport = JsonObject(exported + ("formatVersion" to JsonPrimitive("unsupported")))
            assertFailsWith<DomainException> { source.importJson(invalidExport) }
            assertTrue(source.isBrowserSessionActive(session.rawId, ADMIN_TOKEN))

            Database("jdbc:sqlite::memory:").use { targetDatabase ->
                targetDatabase.migrate()
                val target = ReviewEngine(targetDatabase, Clock.fixed(Instant.parse("2026-08-14T00:00:00Z"), ZoneOffset.UTC))
                val targetSession = target.issueBrowserSession(ADMIN_TOKEN, ADMIN_TOKEN, Duration.ofHours(12))
                target.importJson(exported)
                assertEquals(0, countSessions(targetDatabase))
                assertFalse(target.isBrowserSessionActive(targetSession.rawId, ADMIN_TOKEN))
            }

            assertEquals(1, countSessions(sourceDatabase))
        }
    }

    @Test
    fun `pruning is bounded`() {
        val clock = MutableClock(Instant.parse("2026-08-14T00:00:00Z"))
        Database("jdbc:sqlite::memory:").use { database ->
            database.migrate()
            val engine = ReviewEngine(database, clock)
            repeat(3) { engine.issueBrowserSession(ADMIN_TOKEN, ADMIN_TOKEN, Duration.ofSeconds(1)) }
            clock.advance(Duration.ofSeconds(1))

            assertEquals(2, engine.pruneWebSessions(2))
            assertEquals(1, countSessions(database))
            assertEquals(1, engine.pruneWebSessions(2))
            assertEquals(0, countSessions(database))
            assertFailsWith<IllegalArgumentException> {
                engine.pruneWebSessions(WebSessionRepository.MAX_PRUNE_BATCH_SIZE + 1)
            }
        }
    }

    private fun withEngine(block: (Database, ReviewEngine, MutableClock) -> Unit) {
        val clock = MutableClock(Instant.parse("2026-08-14T00:00:00Z"))
        Database("jdbc:sqlite::memory:").use { database ->
            database.migrate()
            block(database, ReviewEngine(database, clock), clock)
        }
    }

    private fun countSessions(database: Database): Int = database.read { connection ->
        connection.createStatement().use { statement ->
            statement.executeQuery("SELECT COUNT(*) FROM web_session").use { result -> result.next(); result.getInt(1) }
        }
    }

    private class MutableClock(private var current: Instant) : Clock() {
        override fun getZone() = ZoneOffset.UTC
        override fun withZone(zone: java.time.ZoneId): Clock = this
        override fun instant(): Instant = current
        fun advance(duration: Duration) {
            current = current.plus(duration)
        }
    }

    private companion object {
        const val ADMIN_TOKEN = "session-test-administrator-token"
    }
}
