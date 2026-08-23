package dev.reviewengine.domain

import java.time.Instant
import java.util.UUID

enum class TemplateStatus(val databaseValue: String) {
    DRAFT("draft"),
    PUBLISHED("published"),
    RETIRED("retired");

    companion object {
        fun fromDatabase(value: String): TemplateStatus = entries.firstOrNull { it.databaseValue == value }
            ?: domainFailure(DomainErrorCode.CONFLICT, "Unknown template status", "status" to value)
    }
}

enum class ReviewStatus(val databaseValue: String) {
    DRAFT("draft"),
    FINAL("final"),
    SUPERSEDED("superseded");

    companion object {
        fun fromDatabase(value: String): ReviewStatus = entries.firstOrNull { it.databaseValue == value }
            ?: domainFailure(DomainErrorCode.CONFLICT, "Unknown review status", "status" to value)
    }
}

data class Category(
    val id: UUID,
    val name: String,
    val description: String? = null,
    val activeTemplateVersionId: UUID? = null,
    val archivedAt: Instant? = null,
    val createdAt: Instant,
    val updatedAt: Instant,
    val lockVersion: Long = 0,
)

data class Criterion(
    val id: UUID,
    val categoryId: UUID,
    val createdAt: Instant,
)

data class TemplateVersion(
    val id: UUID,
    val categoryId: UUID,
    val version: Int,
    val status: TemplateStatus,
    val publishedAt: Instant? = null,
    val createdAt: Instant,
    val updatedAt: Instant,
    val lockVersion: Long = 0,
)

data class TemplateCriterion(
    val templateVersionId: UUID,
    val criterionId: UUID,
    val name: String,
    val description: String? = null,
    val scale: Scale,
    val position: Int,
    val required: Boolean,
)

data class TemplateDefinition(
    val version: TemplateVersion,
    val criteria: List<TemplateCriterion>,
) {
    init {
        if (criteria.any { it.templateVersionId != version.id }) {
            domainFailure(DomainErrorCode.CONFLICT, "Template criterion belongs to another template version")
        }
        val duplicateCriterion = criteria.groupingBy { it.criterionId }.eachCount().entries.firstOrNull { it.value > 1 }
        if (duplicateCriterion != null) {
            domainFailure(
                DomainErrorCode.DUPLICATE_CRITERION,
                "A criterion can only occur once in a template version",
                "criterionId" to duplicateCriterion.key,
            )
        }
        val duplicatePosition = criteria.groupingBy { it.position }.eachCount().entries.firstOrNull { it.value > 1 }
        if (duplicatePosition != null || criteria.any { it.position < 0 }) {
            domainFailure(DomainErrorCode.CONFLICT, "Template criterion positions must be unique and non-negative")
        }
    }
}

data class Entity(
    val id: UUID,
    val categoryId: UUID,
    val name: String,
    val description: String? = null,
    val archivedAt: Instant? = null,
    val createdAt: Instant,
    val updatedAt: Instant,
    val lockVersion: Long = 0,
)

data class Reviewer(
    val id: UUID,
    val displayName: String,
    val createdAt: Instant,
    val archivedAt: Instant? = null,
)

data class Review(
    val id: UUID,
    val entityId: UUID,
    val reviewerId: UUID,
    val templateVersionId: UUID,
    val reviewedAt: Instant,
    val status: ReviewStatus,
    val supersedesReviewId: UUID? = null,
    val createdAt: Instant,
    val updatedAt: Instant,
    val lockVersion: Long = 0,
    val hiddenAt: Instant? = null,
)

data class Score(
    val reviewId: UUID,
    val criterionId: UUID,
    val tickIndex: Long,
)

data class ReviewWithScores(
    val review: Review,
    val scores: List<Score>,
)

data class RelationType(
    val id: UUID,
    val key: String,
    val forwardLabel: String,
    val inverseLabel: String,
    val hierarchical: Boolean,
    val createdAt: Instant,
)

data class EntityRelation(
    val id: UUID,
    val sourceEntityId: UUID,
    val targetEntityId: UUID,
    val relationTypeId: UUID,
    val createdAt: Instant,
)

enum class RelationDirection {
    OUTGOING,
    INCOMING,
    BOTH,
}

data class RelatedEntity(
    val entityId: UUID,
    val depth: Int,
)

data class AccessToken(
    val id: UUID,
    val name: String,
    val tokenHash: String,
    val createdAt: Instant,
    val revokedAt: Instant? = null,
)

enum class WebSessionIdentity(val databaseValue: String) {
    ADMIN("admin"),
    ACCESS_TOKEN("access_token");

    companion object {
        fun fromDatabase(value: String): WebSessionIdentity = entries.firstOrNull { it.databaseValue == value }
            ?: domainFailure(DomainErrorCode.CONFLICT, "Unknown web session identity", "identityKind" to value)
    }
}

/** Contains fingerprints only; the opaque browser session secret is never persisted. */
data class WebSession(
    val sessionHash: String,
    val identityKind: WebSessionIdentity,
    val credentialHash: String,
    val createdAt: Instant,
    val expiresAt: Instant,
    val revokedAt: Instant? = null,
)

object DomainRules {
    fun requireTemplatePublishable(template: TemplateDefinition) {
        requireTemplateEditable(template.version)
        if (template.criteria.isEmpty()) {
            domainFailure(
                DomainErrorCode.INVALID_STATE_TRANSITION,
                "A template must define at least one criterion before publication",
                "templateVersionId" to template.version.id,
            )
        }
    }

    fun requireTemplateEditable(template: TemplateVersion) {
        if (template.status != TemplateStatus.DRAFT) {
            domainFailure(
                DomainErrorCode.IMMUTABLE_RESOURCE,
                "Published or retired template versions cannot be edited",
                "templateVersionId" to template.id,
                "status" to template.status.databaseValue,
            )
        }
    }

    fun requireReviewEditable(review: Review) {
        if (review.status != ReviewStatus.DRAFT) {
            domainFailure(
                DomainErrorCode.IMMUTABLE_RESOURCE,
                "Final or superseded reviews cannot be edited",
                "reviewId" to review.id,
                "status" to review.status.databaseValue,
            )
        }
    }

    fun requireCategoryMatch(entity: Entity, template: TemplateVersion) {
        if (entity.categoryId != template.categoryId) {
            domainFailure(
                DomainErrorCode.CATEGORY_MISMATCH,
                "Entity and template version must belong to the same category",
                "entityCategoryId" to entity.categoryId,
                "templateCategoryId" to template.categoryId,
            )
        }
    }

    fun requireEntityCategoryChangeAllowed(hasFinalReview: Boolean) {
        if (hasFinalReview) {
            domainFailure(
                DomainErrorCode.INVALID_STATE_TRANSITION,
                "An entity with a final review cannot change category",
            )
        }
    }

    fun validateScores(
        template: TemplateDefinition,
        scores: Collection<Score>,
        requireComplete: Boolean,
    ) {
        val duplicate = scores.groupingBy { it.criterionId }.eachCount().entries.firstOrNull { it.value > 1 }
        if (duplicate != null) {
            domainFailure(
                DomainErrorCode.DUPLICATE_CRITERION,
                "A review can only contain one score per criterion",
                "criterionId" to duplicate.key,
            )
        }

        val definitions = template.criteria.associateBy { it.criterionId }
        scores.forEach { score ->
            val criterion = definitions[score.criterionId] ?: domainFailure(
                DomainErrorCode.UNKNOWN_CRITERION,
                "Score criterion is not defined by the review template",
                "criterionId" to score.criterionId,
                "templateVersionId" to template.version.id,
            )
            criterion.scale.requireTick(score.tickIndex)
        }

        if (requireComplete) {
            val supplied = scores.mapTo(mutableSetOf()) { it.criterionId }
            val missing = template.criteria.firstOrNull { it.required && it.criterionId !in supplied }
            if (missing != null) {
                domainFailure(
                    DomainErrorCode.REQUIRED_SCORE_MISSING,
                    "A required criterion has no score",
                    "criterionId" to missing.criterionId,
                    "templateVersionId" to template.version.id,
                )
            }
        }
    }
}
