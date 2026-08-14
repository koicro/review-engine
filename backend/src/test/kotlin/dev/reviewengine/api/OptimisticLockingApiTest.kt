package dev.reviewengine.api

import dev.reviewengine.application.ReviewEngine
import dev.reviewengine.persistence.Database
import io.ktor.client.request.bearerAuth
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class OptimisticLockingApiTest {
    private val json = Json

    @Test
    fun `stale review finalization is rejected without changing the draft`() {
        Database("jdbc:sqlite::memory:").use { database ->
            database.migrate()
            val engine = ReviewEngine(database)
            testApplication {
                application {
                    reviewEngineModule(
                        engine,
                        AppConfig("127.0.0.1", 8080, "jdbc:sqlite::memory:", false, TOKEN, emptyList()),
                    )
                }

                val category = postJson("/api/v1/categories", """{"name":"Coffee"}""")
                val categoryId = category.string("id")
                val draft = postJson(
                    "/api/v1/categories/$categoryId/template-versions",
                    """{"criteria":[{"name":"Taste","maxValue":"5","stepValue":"1","position":0,"required":true}]}""",
                )
                val templateId = draft.string("id")
                val criterionId = draft.getValue("criteria").jsonArray.single().jsonObject.string("criterionId")
                postJson(
                    "/api/v1/template-versions/$templateId/publish",
                    """{"revision":${draft.long("revision")}}""",
                )
                val entity = postJson(
                    "/api/v1/entities",
                    """{"categoryId":"$categoryId","name":"Latte"}""",
                )
                val review = postJson(
                    "/api/v1/entities/${entity.string("id")}/reviews",
                    """{"reviewedAt":"2026-08-13T00:00:00Z","scores":[{"criterionId":"$criterionId","tickIndex":4}]}""",
                )

                val stale = client.post("/api/v1/reviews/${review.string("id")}/finalize") {
                    bearerAuth(TOKEN)
                    header(HttpHeaders.ContentType, ContentType.Application.Json)
                    setBody("""{"revision":99}""")
                }
                assertEquals(HttpStatusCode.Conflict, stale.status)
                assertEquals(
                    "OPTIMISTIC_LOCK_CONFLICT",
                    json.parseToJsonElement(stale.bodyAsText()).jsonObject.string("code"),
                )

                val finalized = postJson(
                    "/api/v1/reviews/${review.string("id")}/finalize",
                    """{"revision":${review.long("revision")}}""",
                )
                assertEquals("final", finalized.string("status"))
            }
        }
    }

    @Test
    fun `review creation can finalize scores atomically`() {
        Database("jdbc:sqlite::memory:").use { database ->
            database.migrate()
            val engine = ReviewEngine(database)
            testApplication {
                application {
                    reviewEngineModule(
                        engine,
                        AppConfig("127.0.0.1", 8080, "jdbc:sqlite::memory:", false, TOKEN, emptyList()),
                    )
                }
                val category = postJson("/api/v1/categories", """{"name":"Coffee"}""")
                val categoryId = category.string("id")
                val draft = postJson(
                    "/api/v1/categories/$categoryId/template-versions",
                    """{"criteria":[{"name":"Taste","maxValue":"5","stepValue":"1","position":0,"required":true}]}""",
                )
                val criterionId = draft.getValue("criteria").jsonArray.single().jsonObject.string("criterionId")
                postJson(
                    "/api/v1/template-versions/${draft.string("id")}/publish",
                    """{"revision":${draft.long("revision")}}""",
                )
                val entity = postJson(
                    "/api/v1/entities",
                    """{"categoryId":"$categoryId","name":"Latte"}""",
                )

                val review = postJson(
                    "/api/v1/entities/${entity.string("id")}/reviews",
                    """{
                      "reviewedAt":"2026-08-13T00:00:00Z",
                      "finalize":true,
                      "scores":[{"criterionId":"$criterionId","tickIndex":4}]
                    }""".trimIndent(),
                )

                assertEquals("final", review.string("status"))
                assertEquals(1, review.getValue("scores").jsonArray.size)
            }
        }
    }

    private suspend fun io.ktor.server.testing.ApplicationTestBuilder.postJson(path: String, body: String): JsonObject {
        val response = client.post(path) {
            bearerAuth(TOKEN)
            header(HttpHeaders.ContentType, ContentType.Application.Json)
            setBody(body)
        }
        assertTrue(response.status.value in 200..299, "${response.status}: ${response.bodyAsText()}")
        return json.parseToJsonElement(response.bodyAsText()).jsonObject
    }

    private fun JsonObject.string(name: String): String = getValue(name).jsonPrimitive.content
    private fun JsonObject.long(name: String): Long = getValue(name).jsonPrimitive.content.toLong()

    private companion object {
        const val TOKEN = "test-administrator-token"
    }
}
