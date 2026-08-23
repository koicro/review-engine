package dev.reviewengine.application

import dev.reviewengine.domain.Category
import dev.reviewengine.domain.Entity
import dev.reviewengine.domain.EntityRelation
import dev.reviewengine.domain.RelationType
import dev.reviewengine.domain.Review
import dev.reviewengine.domain.ReviewPicture
import dev.reviewengine.domain.Scale
import dev.reviewengine.domain.TemplateCriterion
import dev.reviewengine.domain.TemplateVersion
import java.time.Instant
import java.util.UUID

data class Page<T>(
    val items: List<T>,
    val nextCursor: String? = null,
)

data class CriterionInput(
    val criterionId: UUID? = null,
    val name: String,
    val description: String? = null,
    val minValue: String = "0",
    val maxValue: String,
    val stepValue: String,
    val position: Int,
    val required: Boolean,
) {
    fun scale(): Scale = Scale.of(minValue, maxValue, stepValue)
}

data class TemplateSnapshot(
    val version: TemplateVersion,
    val criteria: List<TemplateCriterion>,
)

data class EntitySnapshot(
    val entity: Entity,
    val categoryName: String,
    val reviewCount: Long = 0,
    val latestReviewedAt: Instant? = null,
)

data class ScoreInput(
    val criterionId: UUID,
    val tickIndex: Long,
)

data class ScoreSnapshot(
    val criterionId: UUID,
    val criterionName: String,
    val tickIndex: Long,
    val displayValue: String,
    val normalizedValue: String,
    val minValue: String,
    val maxValue: String,
    val stepValue: String,
)

data class ReviewSnapshot(
    val review: Review,
    val reviewerName: String,
    val templateVersion: Int,
    val scores: List<ScoreSnapshot>,
    val pictures: List<ReviewPicture> = emptyList(),
)

enum class Aggregation { LATEST, MEAN, HISTORY }

data class ProjectionCriterion(
    val criterionId: UUID,
    val name: String,
    val position: Int,
    val missing: Boolean,
    val displayValue: String? = null,
    val normalizedValue: String? = null,
    val minValue: String? = null,
    val maxValue: String? = null,
    val sampleCount: Int = 0,
)

data class ComparisonEntity(
    val entity: Entity,
    val reviewCount: Int,
    val lastReviewedAt: Instant?,
    val criteria: List<ProjectionCriterion>,
    val overallNormalizedValue: String?,
    val history: List<ReviewSnapshot> = emptyList(),
)

data class ComparisonSnapshot(
    val categoryId: UUID,
    val aggregation: Aggregation,
    val criteria: List<ProjectionCriterion>,
    val entities: List<ComparisonEntity>,
)

data class RelationSnapshot(
    val relation: EntityRelation,
    val source: Entity,
    val target: Entity,
    val type: RelationType,
)

enum class RelationDirection { OUTGOING, INCOMING, BOTH }

data class RelatedEntitySnapshot(
    val entity: Entity,
    val relation: EntityRelation,
    val type: RelationType,
    val direction: RelationDirection,
    val depth: Int,
    val path: List<UUID>,
)

data class CategoryUpdate(
    val name: String? = null,
    val description: String? = null,
    val descriptionSpecified: Boolean = false,
    val archived: Boolean? = null,
    val expectedLockVersion: Long? = null,
)

data class EntityUpdate(
    val name: String? = null,
    val description: String? = null,
    val descriptionSpecified: Boolean = false,
    val categoryId: UUID? = null,
    val archived: Boolean? = null,
    val expectedLockVersion: Long? = null,
)

data class ReviewWrite(
    val reviewedAt: Instant,
    val reviewerId: UUID,
    val scores: List<ScoreInput>,
    val expectedLockVersion: Long? = null,
    val finalize: Boolean = false,
)

data class ComparisonQuery(
    val categoryId: UUID,
    val entityIds: List<UUID>,
    val aggregation: Aggregation,
    val from: Instant? = null,
    val to: Instant? = null,
    val reviewerId: UUID? = null,
)

data class ReviewVisibilityUpdate(
    val hidden: Boolean,
    val expectedLockVersion: Long,
)

data class ImportIssue(
    val path: String,
    val code: String,
    val message: String,
)

data class ImportValidation(
    val valid: Boolean,
    val errors: List<ImportIssue>,
    val counts: Map<String, Int>,
    val formatVersion: String,
)

data class TokenRecord(
    val id: UUID,
    val name: String,
    val createdAt: Instant,
    val revokedAt: Instant?,
)

const val DEFAULT_REVIEWER_ID: String = "00000000-0000-0000-0000-000000000001"
const val EXPORT_FORMAT_VERSION: String = "1.1"
