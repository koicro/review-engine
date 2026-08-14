package dev.reviewengine.api

import dev.reviewengine.application.ReviewEngine
import dev.reviewengine.application.issueAccessToken
import dev.reviewengine.application.revokeAccessToken
import dev.reviewengine.persistence.Database
import io.ktor.client.request.bearerAuth
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class BrowserSessionApiTest {
    private val json = Json

    @Test
    fun `session cookie has required flags authenticates and logout revokes it`() {
        withApi(publicOrigin = HTTPS_ORIGIN) { engine ->
            val login = login(ADMIN_TOKEN, HTTPS_ORIGIN)
            assertEquals(HttpStatusCode.NoContent, login.status)
            assertEquals("no-store", login.headers[HttpHeaders.CacheControl])
            val setCookie = assertNotNull(login.headers[HttpHeaders.SetCookie])
            assertTrue(setCookie.contains("$COOKIE_NAME="))
            assertTrue(setCookie.contains("HttpOnly", ignoreCase = true))
            assertTrue(setCookie.contains("SameSite=Strict", ignoreCase = true))
            assertTrue(setCookie.contains("Path=/api/v1", ignoreCase = true))
            assertTrue(setCookie.contains("Max-Age=43200", ignoreCase = true))
            assertTrue(setCookie.contains("Secure", ignoreCase = true))
            assertFalse(setCookie.contains(ADMIN_TOKEN))
            val cookie = setCookie.substringBefore(';')

            assertEquals(
                HttpStatusCode.OK,
                client.get("/api/v1/categories") { header(HttpHeaders.Cookie, cookie) }.status,
            )

            val missingOrigin = client.post("/api/v1/categories") {
                header(HttpHeaders.Cookie, cookie)
                jsonBody("""{"name":"Missing origin"}""")
            }
            assertError(missingOrigin.status, missingOrigin.bodyAsText(), HttpStatusCode.Forbidden, "ORIGIN_MISMATCH")

            val wrongOrigin = client.post("/api/v1/categories") {
                header(HttpHeaders.Cookie, cookie)
                header(HttpHeaders.Origin, "https://attacker.example")
                jsonBody("""{"name":"Wrong origin"}""")
            }
            assertError(wrongOrigin.status, wrongOrigin.bodyAsText(), HttpStatusCode.Forbidden, "ORIGIN_MISMATCH")

            assertEquals(
                HttpStatusCode.Created,
                client.post("/api/v1/categories") {
                    header(HttpHeaders.Cookie, cookie)
                    header(HttpHeaders.Origin, HTTPS_ORIGIN)
                    jsonBody("""{"name":"Cookie request"}""")
                }.status,
            )
            assertEquals(
                HttpStatusCode.Created,
                client.post("/api/v1/categories") {
                    bearerAuth(ADMIN_TOKEN)
                    jsonBody("""{"name":"Bearer request"}""")
                }.status,
                "Bearer API clients must not be subject to browser Origin checks",
            )

            val logout = client.delete("/api/v1/session") {
                header(HttpHeaders.Cookie, cookie)
                header(HttpHeaders.Origin, HTTPS_ORIGIN)
            }
            assertEquals(HttpStatusCode.NoContent, logout.status)
            val expiredCookie = assertNotNull(logout.headers[HttpHeaders.SetCookie])
            assertTrue(expiredCookie.contains("Max-Age=0", ignoreCase = true))
            assertTrue(expiredCookie.contains("HttpOnly", ignoreCase = true))
            assertTrue(expiredCookie.contains("SameSite=Strict", ignoreCase = true))
            assertTrue(expiredCookie.contains("Secure", ignoreCase = true))
            assertEquals(
                HttpStatusCode.Unauthorized,
                client.get("/api/v1/categories") { header(HttpHeaders.Cookie, cookie) }.status,
            )

            assertEquals(HttpStatusCode.NoContent, client.delete("/api/v1/session").status)
            assertTrue(engine.ready())
        }
    }

    @Test
    fun `login rejects missing origin inactive and oversized credentials with stable errors`() {
        withApi(publicOrigin = HTTPS_ORIGIN) {
            val missingOrigin = login(ADMIN_TOKEN, origin = null)
            assertError(missingOrigin.status, missingOrigin.bodyAsText(), HttpStatusCode.Forbidden, "ORIGIN_MISMATCH")

            val wrongOrigin = login(ADMIN_TOKEN, "https://wrong.example")
            assertError(wrongOrigin.status, wrongOrigin.bodyAsText(), HttpStatusCode.Forbidden, "ORIGIN_MISMATCH")

            val inactive = login("inactive-credential", HTTPS_ORIGIN)
            assertError(inactive.status, inactive.bodyAsText(), HttpStatusCode.Unauthorized, "UNAUTHORIZED")
            assertEquals(null, inactive.headers[HttpHeaders.SetCookie])

            val tooLong = login("x".repeat(513), HTTPS_ORIGIN)
            assertError(tooLong.status, tooLong.bodyAsText(), HttpStatusCode.Unauthorized, "UNAUTHORIZED")

            val tooLarge = client.post("/api/v1/session") {
                header(HttpHeaders.Origin, HTTPS_ORIGIN)
                jsonBody("""{"token":"${"x".repeat(9_000)}"}""")
            }
            assertError(tooLarge.status, tooLarge.bodyAsText(), HttpStatusCode.PayloadTooLarge, "PAYLOAD_TOO_LARGE")
        }
    }

    @Test
    fun `revoking an API token immediately invalidates its browser cookie`() {
        withApi(publicOrigin = HTTP_ORIGIN) { engine ->
            val issuedToken = engine.issueAccessToken("browser")
            val login = login(issuedToken.token, HTTP_ORIGIN)
            assertEquals(HttpStatusCode.NoContent, login.status)
            val setCookie = assertNotNull(login.headers[HttpHeaders.SetCookie])
            assertFalse(setCookie.contains("Secure", ignoreCase = true))
            val cookie = setCookie.substringBefore(';')
            assertEquals(
                HttpStatusCode.OK,
                client.get("/api/v1/categories") { header(HttpHeaders.Cookie, cookie) }.status,
            )

            engine.revokeAccessToken(issuedToken.record.id)
            assertEquals(
                HttpStatusCode.Unauthorized,
                client.get("/api/v1/categories") { header(HttpHeaders.Cookie, cookie) }.status,
            )
        }
    }

    @Test
    fun `public origin configuration is canonical and strictly validated`() {
        assertEquals(
            "https://reviews.example",
            AppConfig.fromEnvironment(environment("https://REVIEWS.example:443")).publicOrigin,
        )
        assertEquals(null, AppConfig.fromEnvironment(environment(null)).publicOrigin)

        listOf(
            "reviews.example",
            "ftp://reviews.example",
            "https://reviews.example/",
            "https://reviews.example/path",
            "https://user@reviews.example",
            "https://reviews.example?query=yes",
            "https://reviews.example#fragment",
        ).forEach { origin ->
            assertFailsWith<IllegalArgumentException>(origin) {
                AppConfig.fromEnvironment(environment(origin))
            }
        }
    }

    private fun withApi(
        publicOrigin: String,
        block: suspend ApplicationTestBuilder.(ReviewEngine) -> Unit,
    ) {
        Database("jdbc:sqlite::memory:").use { database ->
            database.migrate()
            val engine = ReviewEngine(database)
            testApplication {
                application {
                    reviewEngineModule(
                        engine,
                        AppConfig(
                            "127.0.0.1",
                            8080,
                            "jdbc:sqlite::memory:",
                            false,
                            ADMIN_TOKEN,
                            emptyList(),
                            publicOrigin,
                        ),
                    )
                }
                block(engine)
            }
        }
    }

    private suspend fun ApplicationTestBuilder.login(token: String, origin: String?): io.ktor.client.statement.HttpResponse =
        client.post("/api/v1/session") {
            if (origin != null) header(HttpHeaders.Origin, origin)
            jsonBody("""{"token":"$token"}""")
        }

    private fun io.ktor.client.request.HttpRequestBuilder.jsonBody(body: String) {
        header(HttpHeaders.ContentType, ContentType.Application.Json)
        setBody(body)
    }

    private fun assertError(
        actualStatus: HttpStatusCode,
        body: String,
        expectedStatus: HttpStatusCode,
        expectedCode: String,
    ) {
        assertEquals(expectedStatus, actualStatus, body)
        assertEquals(expectedCode, json.parseToJsonElement(body).jsonObject.getValue("code").jsonPrimitive.content)
    }

    private fun environment(publicOrigin: String?): Map<String, String> = buildMap {
        put("REVIEW_ADMIN_TOKEN", ADMIN_TOKEN)
        if (publicOrigin != null) put("REVIEW_PUBLIC_ORIGIN", publicOrigin)
    }

    private companion object {
        const val ADMIN_TOKEN = "browser-session-administrator-token"
        const val COOKIE_NAME = "review_engine_session"
        const val HTTPS_ORIGIN = "https://reviews.example"
        const val HTTP_ORIGIN = "http://reviews.example"
    }
}
