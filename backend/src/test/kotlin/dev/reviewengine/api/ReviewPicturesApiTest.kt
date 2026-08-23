package dev.reviewengine.api

import dev.reviewengine.application.PictureStorage
import dev.reviewengine.application.ReviewEngine
import dev.reviewengine.persistence.Database
import io.ktor.client.call.body
import io.ktor.client.request.bearerAuth
import io.ktor.client.request.delete
import io.ktor.client.request.forms.formData
import io.ktor.client.request.forms.submitFormWithBinaryData
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.Headers
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import java.nio.file.Files
import java.nio.file.Path
import java.util.Base64
import java.util.Comparator
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class ReviewPicturesApiTest {
    private val json = Json { ignoreUnknownKeys = false }

    @Test
    fun `picture storage defaults beside the database and can be overridden`() {
        val base = mapOf(
            "REVIEW_ADMIN_TOKEN" to TOKEN,
            "REVIEW_DATABASE_PATH" to "/var/lib/review/review-engine.db",
        )
        assertEquals(
            "/var/lib/review/review-pictures",
            AppConfig.fromEnvironment(base).picturePath,
        )
        assertEquals(
            "/mnt/pictures",
            AppConfig.fromEnvironment(base + ("REVIEW_PICTURE_PATH" to "/mnt/pictures")).picturePath,
        )
    }

    @Test
    fun `draft pictures remain readable and are shared with a correction`() {
        withPictureApplication { picturePath ->
            val fixture = createFixture()
            val upload = uploadPictures(
                fixture.reviewId,
                fixture.revision,
                listOf("../first.png" to PNG, "second.jpg" to PNG),
            )
            assertEquals(HttpStatusCode.Created, upload.status)
            val uploadedReview = upload.json()
            assertEquals(1L, uploadedReview.long("revision"))
            val pictures = uploadedReview.pictures()
            assertEquals(2, pictures.size)
            assertEquals("first.png", pictures[0].string("fileName"))
            assertEquals("image/png", pictures[0].string("contentType"))
            assertEquals(PNG.size.toLong(), pictures[0].long("sizeBytes"))
            assertEquals(
                "reviews/${fixture.reviewId}/pictures/${pictures[0].string("id")}",
                pictures[0].string("url"),
            )
            assertEquals(2, storedFiles(picturePath).size)

            val portableExport = client.post("/api/v1/exports") { bearerAuth(TOKEN) }.json()
                .getValue("data").jsonObject
            assertFalse("picture_asset" in portableExport)
            assertFalse("review_picture" in portableExport)

            val unauthorized = client.get(pictures[0].apiUrl())
            assertEquals(HttpStatusCode.Unauthorized, unauthorized.status)
            val content = client.get(pictures[0].apiUrl()) { bearerAuth(TOKEN) }
            assertEquals(HttpStatusCode.OK, content.status)
            assertEquals(ContentType.Image.PNG.toString(), content.headers[HttpHeaders.ContentType])
            assertEquals("private, no-store", content.headers[HttpHeaders.CacheControl])
            assertContentEquals(PNG, content.body<ByteArray>())
            assertTrue(content.headers[HttpHeaders.ContentDisposition]?.startsWith("inline") == true)

            val finalized = postJson(
                "/api/v1/reviews/${fixture.reviewId}/finalize",
                """{"revision":1,"scores":[{"criterionId":"${fixture.criterionId}","tickIndex":4}]}""",
            )
            assertEquals("final", finalized.string("status"))
            assertEquals(pictures.map { it.string("id") }, finalized.pictures().map { it.string("id") })

            val immutableUpload = uploadPictures(
                fixture.reviewId,
                finalized.long("revision"),
                listOf("late.png" to PNG),
            )
            assertEquals(HttpStatusCode.Conflict, immutableUpload.status)
            assertEquals("IMMUTABLE_RESOURCE", immutableUpload.json().string("code"))
            assertEquals(2, storedFiles(picturePath).size)

            val immutableDelete = client.delete(
                "/api/v1/reviews/${fixture.reviewId}/pictures/${pictures[0].string("id")}?revision=${finalized.long("revision")}",
            ) { bearerAuth(TOKEN) }
            assertEquals(HttpStatusCode.Conflict, immutableDelete.status)

            val replacement = postJson(
                "/api/v1/reviews/${fixture.reviewId}/revisions",
                """{
                  "reviewedAt":"2026-08-14T00:00:00Z",
                  "scores":[{"criterionId":"${fixture.criterionId}","tickIndex":3}],
                  "revision":${finalized.long("revision")}
                }""".trimIndent(),
            )
            assertEquals("final", replacement.string("status"))
            assertEquals(pictures.map { it.string("id") }, replacement.pictures().map { it.string("id") })
            assertEquals(2, storedFiles(picturePath).size, "Correction must link immutable assets instead of copying them")
            val replacementContent = client.get(replacement.pictures()[0].apiUrl()) { bearerAuth(TOKEN) }
            assertEquals(HttpStatusCode.OK, replacementContent.status)
            assertContentEquals(PNG, replacementContent.body<ByteArray>())
        }
    }

    @Test
    fun `picture limits reject invalid input and draft deletion cleans files`() {
        withPictureApplication { picturePath ->
            val fixture = createFixture()

            val unsupported = uploadPictures(
                fixture.reviewId,
                fixture.revision,
                listOf("notes.png" to "not really a picture".toByteArray()),
            )
            assertEquals(HttpStatusCode.UnsupportedMediaType, unsupported.status)
            assertEquals("UNSUPPORTED_PICTURE_TYPE", unsupported.json().string("code"))
            assertTrue(storedFiles(picturePath).isEmpty())

            val tooManyAtOnce = uploadPictures(
                fixture.reviewId,
                fixture.revision,
                (1..4).map { "picture-$it.png" to PNG },
            )
            assertEquals(HttpStatusCode.Conflict, tooManyAtOnce.status)
            assertEquals("PICTURE_LIMIT_EXCEEDED", tooManyAtOnce.json().string("code"))
            assertTrue(storedFiles(picturePath).isEmpty())

            val full = uploadPictures(
                fixture.reviewId,
                fixture.revision,
                (1..3).map { "picture-$it.png" to PNG },
            ).json()
            assertEquals(3, full.pictures().size)
            assertEquals(3, storedFiles(picturePath).size)

            val staleUpload = uploadPictures(
                fixture.reviewId,
                fixture.revision,
                listOf("stale.png" to PNG),
            )
            assertEquals(HttpStatusCode.Conflict, staleUpload.status)
            assertEquals("OPTIMISTIC_LOCK_CONFLICT", staleUpload.json().string("code"))
            assertEquals(3, storedFiles(picturePath).size)

            val fourth = uploadPictures(
                fixture.reviewId,
                full.long("revision"),
                listOf("fourth.png" to PNG),
            )
            assertEquals(HttpStatusCode.Conflict, fourth.status)
            assertEquals("PICTURE_LIMIT_EXCEEDED", fourth.json().string("code"))
            assertEquals(3, storedFiles(picturePath).size, "Rejected uploads must not leave staged or committed files")

            val firstPictureId = full.pictures().first().string("id")
            val afterDeleteResponse = client.delete(
                "/api/v1/reviews/${fixture.reviewId}/pictures/$firstPictureId?revision=${full.long("revision")}",
            ) { bearerAuth(TOKEN) }
            assertEquals(HttpStatusCode.OK, afterDeleteResponse.status)
            val afterDelete = afterDeleteResponse.json()
            assertEquals(2, afterDelete.pictures().size)
            assertEquals(2, storedFiles(picturePath).size)

            val staleDelete = client.delete(
                "/api/v1/reviews/${fixture.reviewId}/pictures/${afterDelete.pictures().first().string("id")}?revision=${full.long("revision")}",
            ) { bearerAuth(TOKEN) }
            assertEquals(HttpStatusCode.Conflict, staleDelete.status)
            assertEquals(2, storedFiles(picturePath).size)

            val deleteDraft = client.delete(
                "/api/v1/reviews/${fixture.reviewId}?revision=${afterDelete.long("revision")}",
            ) { bearerAuth(TOKEN) }
            assertEquals(HttpStatusCode.NoContent, deleteDraft.status)
            assertTrue(storedFiles(picturePath).isEmpty())
        }
    }

    @Test
    fun `a picture beyond the byte limit returns the stable payload error without leaving a file`() {
        withPictureApplication(maximumPictureSizeBytes = PNG.size.toLong() - 1) { picturePath ->
            val fixture = createFixture()

            val response = uploadPictures(
                fixture.reviewId,
                fixture.revision,
                listOf("too-large.png" to PNG),
            )

            assertEquals(HttpStatusCode.PayloadTooLarge, response.status)
            assertEquals("PAYLOAD_TOO_LARGE", response.json().string("code"))
            assertTrue(storedFiles(picturePath).isEmpty())
        }
    }

    private fun withPictureApplication(
        maximumPictureSizeBytes: Long = dev.reviewengine.application.MAX_PICTURE_SIZE_BYTES,
        test: suspend ApplicationTestBuilder.(Path) -> Unit,
    ) {
        val picturePath = Files.createTempDirectory("review-engine-pictures-")
        try {
            Database("jdbc:sqlite::memory:").use { database ->
                database.migrate()
                val engine = ReviewEngine(
                    database,
                    pictureStorage = PictureStorage(picturePath, maximumPictureSizeBytes),
                )
                val config = AppConfig("127.0.0.1", 8080, "jdbc:sqlite::memory:", false, TOKEN, emptyList())
                testApplication {
                    application { reviewEngineModule(engine, config) }
                    test(picturePath)
                }
            }
        } finally {
            Files.walk(picturePath).use { paths ->
                paths.sorted(Comparator.reverseOrder()).forEach(Files::deleteIfExists)
            }
        }
    }

    private suspend fun ApplicationTestBuilder.createFixture(): Fixture {
        val category = postJson("/api/v1/categories", """{"name":"Coffee"}""")
        val categoryId = category.string("id")
        val template = postJson(
            "/api/v1/categories/$categoryId/template-versions",
            """{"criteria":[{"name":"Taste","maxValue":"5","stepValue":"1","position":0,"required":true}]}""",
        )
        val criterionId = template.getValue("criteria").jsonArray.single().jsonObject.string("criterionId")
        postJson(
            "/api/v1/template-versions/${template.string("id")}/publish",
            """{"revision":${template.long("revision")}}""",
        )
        val entity = postJson(
            "/api/v1/entities",
            """{"categoryId":"$categoryId","name":"Latte"}""",
        )
        val review = postJson(
            "/api/v1/entities/${entity.string("id")}/reviews",
            """{"reviewedAt":"2026-08-13T00:00:00Z"}""",
        )
        return Fixture(review.string("id"), criterionId, review.long("revision"))
    }

    private suspend fun ApplicationTestBuilder.uploadPictures(
        reviewId: String,
        revision: Long,
        pictures: List<Pair<String, ByteArray>>,
    ) = client.submitFormWithBinaryData(
        url = "/api/v1/reviews/$reviewId/pictures",
        formData = formData {
            append("revision", revision.toString())
            pictures.forEach { (fileName, content) ->
                append(
                    "pictures",
                    content,
                    Headers.build {
                        append(HttpHeaders.ContentType, ContentType.Application.OctetStream.toString())
                        append(
                            HttpHeaders.ContentDisposition,
                            "filename=\"$fileName\"",
                        )
                    },
                )
            }
        },
    ) { bearerAuth(TOKEN) }

    private suspend fun ApplicationTestBuilder.postJson(path: String, body: String): JsonObject {
        val response = client.post(path) {
            bearerAuth(TOKEN)
            header(HttpHeaders.ContentType, ContentType.Application.Json)
            setBody(body)
        }
        assertTrue(response.status.value in 200..299, "${response.status}: ${response.bodyAsText()}")
        return response.json()
    }

    private suspend fun io.ktor.client.statement.HttpResponse.json(): JsonObject =
        json.parseToJsonElement(bodyAsText()).jsonObject

    private fun JsonObject.string(name: String): String = getValue(name).jsonPrimitive.content
    private fun JsonObject.long(name: String): Long = getValue(name).jsonPrimitive.content.toLong()
    private fun JsonObject.apiUrl(): String = "/api/v1/${string("url")}"
    private fun JsonObject.pictures(): List<JsonObject> =
        (getValue("pictures") as JsonArray).map { it.jsonObject }

    private fun storedFiles(path: Path): List<Path> = Files.list(path).use { files ->
        files.filter { !it.fileName.toString().startsWith(".upload-") }.toList()
    }

    private data class Fixture(val reviewId: String, val criterionId: String, val revision: Long)

    private companion object {
        const val TOKEN = "test-administrator-token"
        val PNG: ByteArray = Base64.getDecoder().decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        )
    }
}
