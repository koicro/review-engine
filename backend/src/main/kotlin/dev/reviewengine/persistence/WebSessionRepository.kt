package dev.reviewengine.persistence

import dev.reviewengine.domain.WebSession
import dev.reviewengine.domain.WebSessionIdentity
import java.sql.Connection
import java.sql.ResultSet
import java.time.Instant

class WebSessionRepository {
    fun insert(connection: Connection, session: WebSession) {
        connection.prepareStatement(
            """
            INSERT INTO web_session(
                session_hash, identity_kind, credential_hash, created_at, expires_at, revoked_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            """.trimIndent(),
        ).use { statement ->
            statement.setString(1, session.sessionHash)
            statement.setString(2, session.identityKind.databaseValue)
            statement.setString(3, session.credentialHash)
            statement.setInstant(4, session.createdAt)
            statement.setInstant(5, session.expiresAt)
            statement.setNullableInstant(6, session.revokedAt)
            statement.executeUpdate()
        }
    }

    fun findActive(connection: Connection, sessionHash: String, now: Instant): WebSession? = connection.prepareStatement(
        """
        SELECT * FROM web_session
        WHERE session_hash = ? AND revoked_at IS NULL AND expires_at > ?
        """.trimIndent(),
    ).use { statement ->
        statement.setString(1, sessionHash)
        statement.setInstant(2, now)
        statement.executeQuery().use { result -> if (result.next()) result.toWebSession() else null }
    }

    fun revoke(connection: Connection, sessionHash: String, revokedAt: Instant): Boolean = connection.prepareStatement(
        "UPDATE web_session SET revoked_at = ? WHERE session_hash = ? AND revoked_at IS NULL",
    ).use { statement ->
        statement.setInstant(1, revokedAt)
        statement.setString(2, sessionHash)
        statement.executeUpdate() == 1
    }

    /** Deletes at most [limit] stale rows so request-time maintenance has bounded latency. */
    fun prune(connection: Connection, now: Instant, limit: Int): Int {
        require(limit in 1..MAX_PRUNE_BATCH_SIZE) { "limit must be between 1 and $MAX_PRUNE_BATCH_SIZE" }
        return connection.prepareStatement(
            """
            DELETE FROM web_session
            WHERE session_hash IN (
                SELECT session_hash FROM web_session
                WHERE expires_at <= ? OR revoked_at IS NOT NULL
                ORDER BY expires_at, session_hash
                LIMIT ?
            )
            """.trimIndent(),
        ).use { statement ->
            statement.setInstant(1, now)
            statement.setInt(2, limit)
            statement.executeUpdate()
        }
    }

    fun deleteAll(connection: Connection): Int = connection.createStatement().use { statement ->
        statement.executeUpdate("DELETE FROM web_session")
    }

    private fun ResultSet.toWebSession() = WebSession(
        sessionHash = getString("session_hash"),
        identityKind = WebSessionIdentity.fromDatabase(getString("identity_kind")),
        credentialHash = getString("credential_hash"),
        createdAt = instant("created_at"),
        expiresAt = instant("expires_at"),
        revokedAt = nullableInstant("revoked_at"),
    )

    companion object {
        const val MAX_PRUNE_BATCH_SIZE: Int = 1_000
    }
}
