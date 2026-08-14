package dev.reviewengine.application

import dev.reviewengine.domain.ReviewStatus
import dev.reviewengine.persistence.Database
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import java.util.ArrayDeque
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class PortabilityTest {
    @Test
    fun `comparison ordering and ranges use chronological instants`() {
        Database("jdbc:sqlite::memory:").use { database ->
            database.migrate()
            val engine = ReviewEngine(database, fixedClock)
            val category = engine.createCategory("Category", null)
            val criterionId = UUID.randomUUID()
            val template = engine.createTemplateDraft(
                category.id,
                listOf(CriterionInput(criterionId, "Criterion", maxValue = "5", stepValue = "1", position = 0, required = true)),
            )
            engine.publishTemplate(template.version.id, template.version.lockVersion)
            val entity = engine.createEntity(category.id, "Entity", null)
            engine.createReview(
                entity.entity.id,
                write(Instant.parse("2026-08-13T00:00:00Z"), criterionId).copy(finalize = true),
            )
            engine.createReview(
                entity.entity.id,
                write(Instant.parse("2026-08-13T00:00:00.100Z"), criterionId).copy(finalize = true),
            )

            val comparison = engine.compare(
                ComparisonQuery(
                    categoryId = category.id,
                    entityIds = listOf(entity.entity.id),
                    aggregation = Aggregation.LATEST,
                    from = Instant.parse("2026-08-13T00:00:00.050Z"),
                ),
            )
            assertEquals(Instant.parse("2026-08-13T00:00:00.100Z"), comparison.entities.single().lastReviewedAt)
            assertEquals(1, comparison.entities.single().reviewCount)
        }
    }

    @Test
    fun `multi revision export restores regardless of UUID order and canonicalizes timestamps`() {
        revisionFixture { source, ids ->
            assertEquals(
                listOf(ids.reviewC, ids.reviewB, ids.reviewA),
                source.listReviews(ids.entity, includeSuperseded = true).items.map { it.review.id },
            )
            val exported = source.exportJson().updateRow("review", ids.reviewC) { row ->
                JsonObject(row + ("reviewed_at" to JsonPrimitive("2026-08-13T09:00:00.200+09:00")))
            }
            val exportedReviewIds = exported.table("review").map { it.jsonObject.getValue("id").jsonPrimitive.content }
            assertEquals(listOf(ids.reviewC.toString(), ids.reviewB.toString(), ids.reviewA.toString()), exportedReviewIds)

            Database("jdbc:sqlite::memory:").use { targetDatabase ->
                targetDatabase.migrate()
                val target = ReviewEngine(targetDatabase, fixedClock)
                assertTrue(target.validateImport(exported).valid)
                target.importJson(exported)

                val restored = target.listReviews(ids.entity, includeSuperseded = true).items
                assertEquals(listOf(ids.reviewC, ids.reviewB, ids.reviewA), restored.map { it.review.id })
                assertEquals(
                    listOf(ReviewStatus.FINAL, ReviewStatus.SUPERSEDED, ReviewStatus.SUPERSEDED),
                    restored.map { it.review.status },
                )
                val storedTimestamp = targetDatabase.read { connection ->
                    connection.prepareStatement("SELECT reviewed_at FROM review WHERE id = ?").use { statement ->
                        statement.setString(1, ids.reviewC.toString())
                        statement.executeQuery().use { result -> assertTrue(result.next()); result.getString(1) }
                    }
                }
                assertEquals("2026-08-13T00:00:00.200000000Z", storedTimestamp)
            }
        }
    }

    @Test
    fun `revision validation rejects cycles and superseded leaves`() {
        revisionFixture { source, ids ->
            val exported = source.exportJson()
            val cycle = exported
                .updateRow("review", ids.reviewA) { row ->
                    JsonObject(row + ("supersedes_review_id" to JsonPrimitive(ids.reviewC.toString())))
                }
                .updateRow("review", ids.reviewC) { row ->
                    JsonObject(row + ("status" to JsonPrimitive("superseded")))
                }
            val cycleValidation = source.validateImport(cycle)
            assertFalse(cycleValidation.valid)
            assertTrue(cycleValidation.errors.any { it.message.contains("cycle") })

            val missingLeaf = exported.updateRow("review", ids.reviewC) { row ->
                JsonObject(row + ("status" to JsonPrimitive("superseded")))
            }
            val leafValidation = source.validateImport(missingLeaf)
            assertFalse(leafValidation.valid)
            assertTrue(leafValidation.errors.any { it.message.contains("no replacement") })
        }
    }

    @Test
    fun `portable integers require JSON integer types and bounded values`() {
        revisionFixture { source, ids ->
            val exported = source.exportJson()

            val textTick = exported.updateFirstRow("score") { row ->
                JsonObject(row + ("tick_index" to JsonPrimitive("abc")))
            }
            assertTrue(source.validateImport(textTick).errors.any { it.path.endsWith(".tick_index") && it.code == "INVALID_TYPE" })

            val invalidBoolean = exported.updateFirstRow("template_criterion") { row ->
                JsonObject(row + ("required" to JsonPrimitive(2)))
            }
            assertTrue(source.validateImport(invalidBoolean).errors.any { it.path.endsWith(".required") && it.code == "OUT_OF_RANGE" })

            val nullName = exported.updateRow("category", ids.category) { row -> JsonObject(row + ("name" to JsonNull)) }
            assertTrue(source.validateImport(nullName).errors.any { it.path.endsWith(".name") && it.code == "NULL_NOT_ALLOWED" })
        }
    }

    @Test
    fun `import validation bounds strings errors and criteria per template`() {
        Database("jdbc:sqlite::memory:").use { database ->
            database.migrate()
            val engine = ReviewEngine(database, fixedClock)
            val exported = engine.exportJson()
            val tooLongReviewer = exported.updateFirstRow("reviewer") { row ->
                JsonObject(row + ("display_name" to JsonPrimitive("x".repeat(MAX_IMPORT_NAME_LENGTH + 1))))
            }
            assertTrue(engine.validateImport(tooLongReviewer).errors.any { it.code == "STRING_TOO_LONG" })

            val invalidRows = JsonArray(List(MAX_IMPORT_ERRORS + 25) { JsonObject(emptyMap()) })
            val capped = exported.withTable("category", invalidRows)
            assertEquals(MAX_IMPORT_ERRORS, engine.validateImport(capped).errors.size)

            val category = engine.createCategory("Category", null)
            val criteria = (0..MAX_CRITERIA_PER_TEMPLATE).map { position ->
                CriterionInput(
                    criterionId = UUID(0, 1_000L + position),
                    name = "Criterion $position",
                    maxValue = "5",
                    stepValue = "1",
                    position = position,
                    required = false,
                )
            }
            engine.createTemplateDraft(category.id, criteria)
            val tooManyCriteria = engine.validateImport(engine.exportJson())
            assertFalse(tooManyCriteria.valid)
            assertTrue(tooManyCriteria.errors.any { it.message.contains("$MAX_CRITERIA_PER_TEMPLATE criteria") })
        }
    }

    private fun revisionFixture(block: (ReviewEngine, FixtureIds) -> Unit) {
        val ids = FixtureIds(
            category = uuid("00000000-0000-0000-0000-000000000010"),
            template = uuid("00000000-0000-0000-0000-000000000020"),
            criterion = uuid("00000000-0000-0000-0000-000000000021"),
            entity = uuid("00000000-0000-0000-0000-000000000030"),
            reviewA = uuid("ffffffff-ffff-ffff-ffff-ffffffffffff"),
            reviewB = uuid("00000000-0000-0000-0000-000000000040"),
            reviewC = uuid("00000000-0000-0000-0000-000000000035"),
        )
        val generatedIds = ArrayDeque(listOf(ids.category, ids.template, ids.entity, ids.reviewA, ids.reviewB, ids.reviewC))
        Database("jdbc:sqlite::memory:").use { database ->
            database.migrate()
            val engine = ReviewEngine(database, fixedClock) { generatedIds.removeFirst() }
            val category = engine.createCategory("Category", null)
            val template = engine.createTemplateDraft(
                category.id,
                listOf(CriterionInput(ids.criterion, "Criterion", maxValue = "5", stepValue = "1", position = 0, required = true)),
            )
            engine.publishTemplate(template.version.id, template.version.lockVersion)
            val entity = engine.createEntity(category.id, "Entity", null)
            val initial = engine.createReview(
                entity.entity.id,
                write(Instant.parse("2026-08-13T00:00:00Z"), ids.criterion),
            )
            val finalized = engine.finalizeReview(initial.review.id, initial.review.lockVersion)
            val second = engine.reviseReview(
                initial.review.id,
                write(
                    Instant.parse("2026-08-13T00:00:00.100Z"),
                    ids.criterion,
                    expectedLockVersion = finalized.review.lockVersion,
                ),
            )
            engine.reviseReview(
                second.review.id,
                write(
                    Instant.parse("2026-08-13T00:00:00.200Z"),
                    ids.criterion,
                    expectedLockVersion = second.review.lockVersion,
                ),
            )

            assertTrue(generatedIds.isEmpty())
            block(engine, ids)
        }
    }

    private fun write(reviewedAt: Instant, criterionId: UUID, expectedLockVersion: Long? = null) = ReviewWrite(
        reviewedAt = reviewedAt,
        reviewerId = uuid(DEFAULT_REVIEWER_ID),
        scores = listOf(ScoreInput(criterionId, 4)),
        expectedLockVersion = expectedLockVersion,
    )

    private fun JsonObject.table(name: String): JsonArray = getValue("data").jsonObject.getValue(name).jsonArray

    private fun JsonObject.withTable(name: String, rows: JsonArray): JsonObject {
        val data = getValue("data").jsonObject
        return JsonObject(this + ("data" to JsonObject(data + (name to rows))))
    }

    private fun JsonObject.updateFirstRow(table: String, transform: (JsonObject) -> JsonObject): JsonObject {
        val rows = table(table)
        return withTable(table, JsonArray(rows.mapIndexed { index, row -> if (index == 0) transform(row.jsonObject) else row }))
    }

    private fun JsonObject.updateRow(table: String, id: UUID, transform: (JsonObject) -> JsonObject): JsonObject {
        val rows = table(table)
        return withTable(
            table,
            JsonArray(rows.map { row -> if (row.jsonObject.getValue("id").jsonPrimitive.content == id.toString()) transform(row.jsonObject) else row }),
        )
    }

    private data class FixtureIds(
        val category: UUID,
        val template: UUID,
        val criterion: UUID,
        val entity: UUID,
        val reviewA: UUID,
        val reviewB: UUID,
        val reviewC: UUID,
    )

    private companion object {
        val fixedClock: Clock = Clock.fixed(Instant.parse("2026-08-13T12:00:00Z"), ZoneOffset.UTC)
        fun uuid(value: String): UUID = UUID.fromString(value)
    }
}
