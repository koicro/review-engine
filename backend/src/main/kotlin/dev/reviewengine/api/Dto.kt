package dev.reviewengine.api

import dev.reviewengine.application.CategoryUpdate
import dev.reviewengine.application.ComparisonEntity
import dev.reviewengine.application.ComparisonSnapshot
import dev.reviewengine.application.CriterionInput
import dev.reviewengine.application.EntitySnapshot
import dev.reviewengine.application.EntityUpdate
import dev.reviewengine.application.Page
import dev.reviewengine.application.ProjectionCriterion
import dev.reviewengine.application.RelatedEntitySnapshot
import dev.reviewengine.application.RelationSnapshot
import dev.reviewengine.application.ReviewSnapshot
import dev.reviewengine.application.ReviewVisibilityUpdate
import dev.reviewengine.application.ReviewWrite
import dev.reviewengine.application.ScoreInput
import dev.reviewengine.application.TemplateSnapshot
import dev.reviewengine.domain.Category
import dev.reviewengine.domain.Entity
import dev.reviewengine.domain.RelationType
import java.time.Instant
import java.util.UUID
import kotlinx.serialization.Serializable

@Serializable
data class ErrorDto(
    val code: String,
    val message: String,
    val details: Map<String, String> = emptyMap(),
)

@Serializable
class SessionCreateDto(val token: String)

@Serializable
data class PageDto<T>(val items: List<T>, val nextCursor: String? = null)

@Serializable
data class CategoryDto(
    val id: String,
    val name: String,
    val description: String? = null,
    val activeTemplateVersionId: String? = null,
    val archivedAt: String? = null,
    val createdAt: String,
    val updatedAt: String,
    val revision: Long,
)

@Serializable
data class CategoryCreateDto(val name: String, val description: String? = null)

@Serializable
data class CategoryPatchDto(
    val name: String? = null,
    val description: String? = null,
    val archived: Boolean? = null,
    val revision: Long? = null,
) {
    fun input() = CategoryUpdate(
        name,
        description,
        descriptionSpecified = description != null,
        archived,
        revision,
    )
}

@Serializable
data class CriterionDto(
    val id: String,
    val criterionId: String = id,
    val name: String,
    val description: String? = null,
    val minValue: String,
    val maxValue: String,
    val stepValue: String,
    val position: Int,
    val required: Boolean,
)

@Serializable
data class CriterionWriteDto(
    val id: String? = null,
    val criterionId: String? = null,
    val name: String,
    val description: String? = null,
    val minValue: String = "0",
    val maxValue: String,
    val stepValue: String,
    val position: Int,
    val required: Boolean,
) {
    fun input() = CriterionInput(
        criterionId = (criterionId ?: id)?.let(::uuid),
        name = name,
        description = description,
        minValue = minValue,
        maxValue = maxValue,
        stepValue = stepValue,
        position = position,
        required = required,
    )
}

@Serializable
data class TemplateVersionDto(
    val id: String,
    val categoryId: String,
    val version: Int,
    val status: String,
    val criteria: List<CriterionDto>,
    val publishedAt: String? = null,
    val createdAt: String,
    val updatedAt: String,
    val revision: Long,
)

@Serializable
data class TemplateDraftCreateDto(val criteria: List<CriterionWriteDto>? = null)

@Serializable
data class TemplatePatchDto(val criteria: List<CriterionWriteDto>, val revision: Long)

@Serializable
data class RevisionDto(val revision: Long)

@Serializable
data class EntityDto(
    val id: String,
    val categoryId: String,
    val category: CategorySummaryDto,
    val name: String,
    val description: String? = null,
    val createdAt: String,
    val updatedAt: String,
    val archivedAt: String? = null,
    val latestReviewedAt: String? = null,
    val reviewCount: Long = 0,
    val revision: Long,
)

@Serializable
data class CategorySummaryDto(val id: String, val name: String)

@Serializable
data class EntityCreateDto(val categoryId: String, val name: String, val description: String? = null)

@Serializable
data class EntityPatchDto(
    val categoryId: String? = null,
    val name: String? = null,
    val description: String? = null,
    val archived: Boolean? = null,
    val revision: Long? = null,
) {
    fun input() = EntityUpdate(
        name,
        description,
        descriptionSpecified = description != null,
        categoryId?.let(::uuid),
        archived,
        revision,
    )
}

@Serializable
data class ScoreWriteDto(val criterionId: String, val tickIndex: Long)

@Serializable
data class ReviewWriteDto(
    val reviewedAt: String,
    val reviewerId: String? = null,
    val scores: List<ScoreWriteDto> = emptyList(),
    val revision: Long? = null,
    val finalize: Boolean = false,
) {
    fun input(defaultReviewerId: UUID) = ReviewWrite(
        reviewedAt = instant(reviewedAt),
        reviewerId = reviewerId?.let(::uuid) ?: defaultReviewerId,
        scores = scores.map { ScoreInput(uuid(it.criterionId), it.tickIndex) },
        expectedLockVersion = revision,
        finalize = finalize,
    )
}

@Serializable
data class FinalizeReviewDto(val revision: Long, val scores: List<ScoreWriteDto>? = null)

@Serializable
data class ReviewVisibilityDto(val hidden: Boolean, val revision: Long) {
    fun input() = ReviewVisibilityUpdate(hidden, revision)
}

@Serializable
data class ScoreDto(
    val criterionId: String,
    val criterionName: String,
    val tickIndex: Long,
    val displayValue: String,
    val normalizedValue: Double,
    val minValue: String,
    val maxValue: String,
    val stepValue: String,
)

@Serializable
data class ReviewerDto(val id: String, val displayName: String)

@Serializable
data class ReviewDto(
    val id: String,
    val entityId: String,
    val reviewerId: String,
    val reviewer: ReviewerDto,
    val templateVersionId: String,
    val templateVersion: TemplateSummaryDto,
    val reviewedAt: String,
    val createdAt: String,
    val updatedAt: String,
    val status: String,
    val hiddenAt: String? = null,
    val supersedesReviewId: String? = null,
    val scores: List<ScoreDto>,
    val pictures: List<PictureDto> = emptyList(),
    val revision: Long,
)

@Serializable
data class PictureDto(
    val id: String,
    val fileName: String,
    val contentType: String,
    val sizeBytes: Long,
    val url: String,
    val createdAt: String,
)

@Serializable
data class TemplateSummaryDto(val id: String, val version: Int)

@Serializable
data class CriterionProjectionDto(
    val criterionId: String,
    val id: String = criterionId,
    val name: String,
    val position: Int,
    val missing: Boolean,
    val displayValue: String? = null,
    val normalizedValue: Double? = null,
    val minValue: String? = null,
    val maxValue: String? = null,
    val sampleCount: Int = 0,
)

@Serializable
data class ComparisonEntityDto(
    val entityId: String,
    val entityName: String,
    val entity: EntitySummaryDto,
    val reviewCount: Int,
    val lastReviewedAt: String? = null,
    val criteria: List<CriterionProjectionDto>,
    val overallNormalizedValue: Double? = null,
    val history: List<ReviewDto> = emptyList(),
)

@Serializable
data class EntitySummaryDto(val id: String, val categoryId: String, val name: String)

@Serializable
data class ComparisonDto(
    val categoryId: String,
    val aggregation: String,
    val criteria: List<CriterionProjectionDto>,
    val entities: List<ComparisonEntityDto>,
)

@Serializable
data class RelationTypeDto(
    val id: String,
    val key: String,
    val forwardLabel: String,
    val inverseLabel: String,
    val hierarchical: Boolean,
    val createdAt: String,
)

@Serializable
data class RelationTypeCreateDto(
    val key: String,
    val forwardLabel: String,
    val inverseLabel: String,
    val hierarchical: Boolean = false,
)

@Serializable
data class RelationCreateDto(val sourceEntityId: String, val targetEntityId: String, val relationTypeId: String)

@Serializable
data class RelationDto(
    val id: String,
    val sourceEntityId: String,
    val targetEntityId: String,
    val relationTypeId: String,
    val sourceEntity: EntitySummaryDto? = null,
    val targetEntity: EntitySummaryDto? = null,
    val relationType: RelationTypeDto,
    val createdAt: String,
)

@Serializable
data class RelatedEntityDto(
    val entity: EntitySummaryDto,
    val relation: RelationDto,
    val relationType: RelationTypeDto,
    val direction: String,
    val depth: Int,
    val path: List<String>,
)

@Serializable
data class TokenCreateDto(val name: String)

@Serializable
data class TokenDto(
    val id: String,
    val name: String,
    val createdAt: String,
    val revokedAt: String? = null,
)

@Serializable
class IssuedTokenDto(
    val token: TokenDto,
    val secret: String,
)

@Serializable
data class ImportValidationDto(
    val valid: Boolean,
    val errors: List<ImportIssueDto>,
    val counts: Map<String, Int>,
    val formatVersion: String,
)

@Serializable
data class ImportIssueDto(val path: String, val code: String, val message: String)

@Serializable
data class ImportResultDto(val imported: Boolean, val counts: Map<String, Int>)

@Serializable
data class HealthDto(val status: String)

internal fun Category.dto() = CategoryDto(
    id.toString(), name, description, activeTemplateVersionId?.toString(), archivedAt?.toString(),
    createdAt.toString(), updatedAt.toString(), lockVersion,
)

internal fun TemplateSnapshot.dto() = TemplateVersionDto(
    version.id.toString(), version.categoryId.toString(), version.version, version.status.databaseValue,
    criteria.map { criterion ->
        CriterionDto(
            criterion.criterionId.toString(), criterion.criterionId.toString(), criterion.name, criterion.description,
            criterion.scale.minValueString(), criterion.scale.maxValueString(), criterion.scale.stepValueString(),
            criterion.position, criterion.required,
        )
    },
    version.publishedAt?.toString(), version.createdAt.toString(), version.updatedAt.toString(), version.lockVersion,
)

internal fun EntitySnapshot.dto() = EntityDto(
    entity.id.toString(), entity.categoryId.toString(), CategorySummaryDto(entity.categoryId.toString(), categoryName),
    entity.name, entity.description, entity.createdAt.toString(), entity.updatedAt.toString(), entity.archivedAt?.toString(),
    latestReviewedAt?.toString(), reviewCount, entity.lockVersion,
)

internal fun ReviewSnapshot.dto() = ReviewDto(
    review.id.toString(), review.entityId.toString(), review.reviewerId.toString(),
    ReviewerDto(review.reviewerId.toString(), reviewerName), review.templateVersionId.toString(),
    TemplateSummaryDto(review.templateVersionId.toString(), templateVersion), review.reviewedAt.toString(),
    review.createdAt.toString(), review.updatedAt.toString(), review.status.databaseValue,
    review.hiddenAt?.toString(), review.supersedesReviewId?.toString(), scores.map { score ->
        ScoreDto(
            score.criterionId.toString(), score.criterionName, score.tickIndex, score.displayValue,
            score.normalizedValue.toDouble(), score.minValue, score.maxValue, score.stepValue,
        )
    }, pictures.map { picture ->
        PictureDto(
            id = picture.id.toString(),
            fileName = picture.fileName,
            contentType = picture.contentType,
            sizeBytes = picture.sizeBytes,
            url = "reviews/${review.id}/pictures/${picture.id}",
            createdAt = picture.createdAt.toString(),
        )
    }, review.lockVersion,
)

private fun ProjectionCriterion.dto() = CriterionProjectionDto(
    criterionId.toString(), criterionId.toString(), name, position, missing, displayValue,
    normalizedValue?.toDouble(), minValue, maxValue, sampleCount,
)

private fun Entity.summary() = EntitySummaryDto(id.toString(), categoryId.toString(), name)

private fun ComparisonEntity.dto() = ComparisonEntityDto(
    entity.id.toString(), entity.name, entity.summary(), reviewCount, lastReviewedAt?.toString(), criteria.map { it.dto() },
    overallNormalizedValue?.toDouble(), history.map { it.dto() },
)

internal fun ComparisonSnapshot.dto() = ComparisonDto(
    categoryId.toString(), aggregation.name.lowercase(), criteria.map { it.dto() }, entities.map { it.dto() },
)

internal fun RelationType.dto() = RelationTypeDto(
    id.toString(), key, forwardLabel, inverseLabel, hierarchical, createdAt.toString(),
)

internal fun RelationSnapshot.dto() = RelationDto(
    relation.id.toString(), relation.sourceEntityId.toString(), relation.targetEntityId.toString(), relation.relationTypeId.toString(),
    source.summary(), target.summary(), type.dto(), relation.createdAt.toString(),
)

internal fun RelatedEntitySnapshot.dto(): RelatedEntityDto {
    val relationDto = RelationDto(
        relation.id.toString(), relation.sourceEntityId.toString(), relation.targetEntityId.toString(), relation.relationTypeId.toString(),
        relationType = type.dto(), createdAt = relation.createdAt.toString(),
    )
    return RelatedEntityDto(entity.summary(), relationDto, type.dto(), direction.name.lowercase(), depth, path.map(UUID::toString))
}

internal fun <T, R> Page<T>.dto(transform: (T) -> R) = PageDto(items.map(transform), nextCursor)

internal fun uuid(value: String): UUID = try {
    UUID.fromString(value)
} catch (exception: IllegalArgumentException) {
    throw dev.reviewengine.domain.DomainException(
        dev.reviewengine.domain.DomainErrorCode.INVALID_ARGUMENT,
        "Expected a UUID",
        mapOf("value" to value),
        exception,
    )
}

internal fun instant(value: String): Instant = try {
    Instant.parse(value)
} catch (exception: Exception) {
    throw dev.reviewengine.domain.DomainException(
        dev.reviewengine.domain.DomainErrorCode.INVALID_ARGUMENT,
        "Expected an ISO 8601 UTC timestamp",
        mapOf("value" to value),
        exception,
    )
}
