package dev.reviewengine.api

import dev.reviewengine.application.ReviewEngine
import dev.reviewengine.persistence.Database
import io.ktor.client.request.bearerAuth
import io.ktor.client.request.get
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
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

class ApiWorkflowTest {
    private val json = Json { ignoreUnknownKeys = false }

    @Test
    fun `category through normalized comparison uses only the public API`() {
        Database("jdbc:sqlite::memory:").use { database ->
            database.migrate()
            val engine = ReviewEngine(database)
            val config = AppConfig(
                host = "127.0.0.1",
                port = 8080,
                jdbcUrl = "jdbc:sqlite::memory:",
                uiEnabled = false,
                adminToken = TOKEN,
                corsOrigins = emptyList(),
            )
            testApplication {
                application { reviewEngineModule(engine, config) }

                assertEquals(HttpStatusCode.OK, client.get("/api/v1/health/ready").status)
                assertEquals(HttpStatusCode.OK, client.get("/openapi.json").status)
                val unauthorized = client.get("/api/v1/categories")
                assertEquals(HttpStatusCode.Unauthorized, unauthorized.status)
                assertTrue(unauthorized.headers[HttpHeaders.WWWAuthenticate]?.startsWith("Bearer") == true)
                val unauthorizedBody = json.parseToJsonElement(unauthorized.bodyAsText()).jsonObject
                assertEquals("UNAUTHORIZED", unauthorizedBody.string("code"))
                assertEquals("A valid bearer token or browser session is required", unauthorizedBody.string("message"))

                val category = postJson("/api/v1/categories", """{"name":"Coffee"}""")
                val categoryId = category.string("id")
                val draft = postJson(
                    "/api/v1/categories/$categoryId/template-versions",
                    """
                    {"criteria":[{
                      "name":"Taste","minValue":"0","maxValue":"5","stepValue":"1",
                      "position":0,"required":true
                    }]}
                    """.trimIndent(),
                )
                val templateId = draft.string("id")
                val criterionId = draft["criteria"]!!.jsonArray.single().jsonObject.string("criterionId")
                val revision = draft["revision"]!!.jsonPrimitive.content
                postJson("/api/v1/template-versions/$templateId/publish", """{"revision":$revision}""")

                val entity = postJson(
                    "/api/v1/entities",
                    """{"categoryId":"$categoryId","name":"Latte"}""",
                )
                val entityId = entity.string("id")
                val review = postJson(
                    "/api/v1/entities/$entityId/reviews",
                    """{
                      "reviewedAt":"2026-08-13T00:00:00Z",
                      "scores":[{"criterionId":"$criterionId","tickIndex":4}]
                    }""",
                )
                assertEquals("draft", review.string("status"))
                val reviewId = review.string("id")
                val reviewRevision = review["revision"]!!.jsonPrimitive.content
                val final = postJson(
                    "/api/v1/reviews/$reviewId/finalize",
                    """{"revision":$reviewRevision,"scores":[{"criterionId":"$criterionId","tickIndex":4}]}""",
                )
                assertEquals("final", final.string("status"))

                val comparisonResponse = client.get(
                    "/api/v1/comparisons?categoryId=$categoryId&entityId=$entityId&aggregation=mean",
                ) { bearerAuth(TOKEN) }
                assertEquals(HttpStatusCode.OK, comparisonResponse.status)
                val comparison = json.parseToJsonElement(comparisonResponse.bodyAsText()).jsonObject
                val projection = comparison["entities"]!!.jsonArray.single().jsonObject
                    .getValue("criteria").jsonArray.single().jsonObject
                assertFalse(projection.getValue("missing").jsonPrimitive.content.toBoolean())
                assertEquals(0.8, projection.getValue("normalizedValue").jsonPrimitive.double)

                val historyResponse = client.get("/api/v1/entities/$entityId/reviews") { bearerAuth(TOKEN) }
                assertEquals(HttpStatusCode.OK, historyResponse.status)
                assertEquals(1, json.parseToJsonElement(historyResponse.bodyAsText()).jsonObject.getValue("items").jsonArray.size)
            }
        }
    }

    @Test
    fun `import validation rejects invalid IDs without changing the database`() {
        Database("jdbc:sqlite::memory:").use { database ->
            database.migrate()
            val engine = ReviewEngine(database)
            val config = AppConfig("127.0.0.1", 8080, "jdbc:sqlite::memory:", false, TOKEN, emptyList())
            testApplication {
                application { reviewEngineModule(engine, config) }
                val exported = postJson("/api/v1/exports", null)
                val category = kotlinx.serialization.json.buildJsonObject {
                    exported.forEach { (key, value) -> put(key, value) }
                    put(
                        "data",
                        kotlinx.serialization.json.buildJsonObject {
                            exported.getValue("data").jsonObject.forEach { (key, value) ->
                                if (key == "category") {
                                    put(
                                        key,
                                        kotlinx.serialization.json.buildJsonArray {
                                            add(
                                                kotlinx.serialization.json.buildJsonObject {
                                                    put("id", "not-a-uuid")
                                                    put("name", "Broken")
                                                    put("description", kotlinx.serialization.json.JsonNull)
                                                    put("active_template_version_id", kotlinx.serialization.json.JsonNull)
                                                    put("archived_at", kotlinx.serialization.json.JsonNull)
                                                    put("created_at", "2026-08-13T00:00:00Z")
                                                    put("updated_at", "2026-08-13T00:00:00Z")
                                                    put("lock_version", 0)
                                                },
                                            )
                                        },
                                    )
                                } else put(key, value)
                            }
                        },
                    )
                }
                val response = client.post("/api/v1/imports/validate") {
                    bearerAuth(TOKEN)
                    header(HttpHeaders.ContentType, ContentType.Application.Json)
                    setBody(category.toString())
                }
                assertEquals(HttpStatusCode.OK, response.status)
                val validation = json.parseToJsonElement(response.bodyAsText()).jsonObject
                assertFalse(validation.getValue("valid").jsonPrimitive.content.toBoolean())
                assertTrue(validation.getValue("errors").jsonArray.any { it.jsonObject.string("code") == "INVALID_UUID" })

                val categories = client.get("/api/v1/categories") { bearerAuth(TOKEN) }
                assertEquals(0, json.parseToJsonElement(categories.bodyAsText()).jsonObject.getValue("items").jsonArray.size)
            }
        }
    }

    private suspend fun io.ktor.server.testing.ApplicationTestBuilder.postJson(
        path: String,
        body: String?,
    ): kotlinx.serialization.json.JsonObject {
        val response = client.post(path) {
            bearerAuth(TOKEN)
            if (body != null) {
                header(HttpHeaders.ContentType, ContentType.Application.Json)
                setBody(body)
            }
        }
        assertTrue(response.status.value in 200..299, "${response.status}: ${response.bodyAsText()}")
        return json.parseToJsonElement(response.bodyAsText()).jsonObject
    }

    private fun kotlinx.serialization.json.JsonObject.string(name: String): String = getValue(name).jsonPrimitive.content

    private companion object {
        const val TOKEN = "test-administrator-token"
    }
}
