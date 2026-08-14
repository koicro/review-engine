package dev.reviewengine.domain

import java.time.Instant
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class DomainRulesTest {
    private val now = Instant.parse("2026-08-13T00:00:00Z")
    private val categoryId = UUID.randomUUID()
    private val templateId = UUID.randomUUID()
    private val requiredCriterionId = UUID.randomUUID()
    private val optionalCriterionId = UUID.randomUUID()
    private val definition = TemplateDefinition(
        version = TemplateVersion(
            id = templateId,
            categoryId = categoryId,
            version = 1,
            status = TemplateStatus.DRAFT,
            createdAt = now,
            updatedAt = now,
        ),
        criteria = listOf(
            TemplateCriterion(templateId, requiredCriterionId, "Taste", scale = Scale.of(maxValue = "5", stepValue = "1"), position = 0, required = true),
            TemplateCriterion(templateId, optionalCriterionId, "Texture", scale = Scale.of(maxValue = "10", stepValue = "2"), position = 1, required = false),
        ),
    )

    @Test
    fun `final review requires every required score`() {
        val failure = assertFailsWith<DomainException> {
            DomainRules.validateScores(definition, emptyList(), requireComplete = true)
        }

        assertEquals(DomainErrorCode.REQUIRED_SCORE_MISSING, failure.code)
    }

    @Test
    fun `draft may omit required score but all supplied scores are validated`() {
        DomainRules.validateScores(definition, emptyList(), requireComplete = false)

        val failure = assertFailsWith<DomainException> {
            DomainRules.validateScores(
                definition,
                listOf(Score(UUID.randomUUID(), optionalCriterionId, 6)),
                requireComplete = false,
            )
        }
        assertEquals(DomainErrorCode.INVALID_TICK_INDEX, failure.code)
    }

    @Test
    fun `template cannot accept an unknown or duplicate criterion`() {
        val reviewId = UUID.randomUUID()
        val unknownFailure = assertFailsWith<DomainException> {
            DomainRules.validateScores(
                definition,
                listOf(Score(reviewId, UUID.randomUUID(), 1)),
                requireComplete = false,
            )
        }
        assertEquals(DomainErrorCode.UNKNOWN_CRITERION, unknownFailure.code)

        val duplicateFailure = assertFailsWith<DomainException> {
            DomainRules.validateScores(
                definition,
                listOf(Score(reviewId, requiredCriterionId, 1), Score(reviewId, requiredCriterionId, 2)),
                requireComplete = true,
            )
        }
        assertEquals(DomainErrorCode.DUPLICATE_CRITERION, duplicateFailure.code)
    }

    @Test
    fun `published review and template values are immutable`() {
        val published = definition.version.copy(status = TemplateStatus.PUBLISHED, publishedAt = now)
        val review = Review(
            id = UUID.randomUUID(),
            entityId = UUID.randomUUID(),
            reviewerId = UUID.randomUUID(),
            templateVersionId = templateId,
            reviewedAt = now,
            status = ReviewStatus.FINAL,
            createdAt = now,
            updatedAt = now,
        )

        assertEquals(
            DomainErrorCode.IMMUTABLE_RESOURCE,
            assertFailsWith<DomainException> { DomainRules.requireTemplateEditable(published) }.code,
        )
        assertEquals(
            DomainErrorCode.IMMUTABLE_RESOURCE,
            assertFailsWith<DomainException> { DomainRules.requireReviewEditable(review) }.code,
        )
    }
}
