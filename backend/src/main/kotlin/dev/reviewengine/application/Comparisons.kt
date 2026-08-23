package dev.reviewengine.application

import dev.reviewengine.domain.DomainErrorCode
import dev.reviewengine.domain.DomainException
import dev.reviewengine.domain.TemplateCriterion
import dev.reviewengine.persistence.toDatabaseTimestamp
import java.math.BigDecimal
import java.math.MathContext
import java.sql.Connection
import java.util.UUID

fun ReviewEngine.compare(query: ComparisonQuery): ComparisonSnapshot = database.read { connection ->
    val category = connection.category(query.categoryId)
    val activeTemplateId = category.activeTemplateVersionId
        ?: conflict("The category has no active template", "categoryId" to query.categoryId)
    val currentCriteria = connection.templateCriteria(activeTemplateId).sortedBy { it.position }
    if (query.entityIds.size > 100) {
        throw DomainException(DomainErrorCode.INVALID_ARGUMENT, "At most 100 entities can be compared")
    }
    val entities = if (query.entityIds.isEmpty()) {
        connection.prepareStatement(
            "SELECT id FROM entity WHERE category_id = ? AND archived_at IS NULL ORDER BY lower(name), id LIMIT 100",
        ).use { statement ->
            statement.setString(1, query.categoryId.toString())
            statement.executeQuery().use { result -> buildList { while (result.next()) add(connection.entity(UUID.fromString(result.getString(1)))) } }
        }
    } else {
        query.entityIds.distinct().map { connection.entity(it) }
    }
    entities.forEach { entity ->
        if (entity.categoryId != query.categoryId) {
            throw DomainException(
                DomainErrorCode.CATEGORY_MISMATCH,
                "Only entities in the requested category can be compared",
                mapOf("entityId" to entity.id.toString()),
            )
        }
        if (entity.archivedAt != null) conflict("Archived entities are excluded from comparisons", "entityId" to entity.id)
    }

    val projections = entities.map { entity ->
        val reviews = eligibleReviews(connection, entity.id, query)
        when (query.aggregation) {
            Aggregation.LATEST -> latestProjection(connection, entity, reviews, currentCriteria)
            Aggregation.MEAN -> meanProjection(connection, entity, reviews, currentCriteria)
            Aggregation.HISTORY -> historyProjection(connection, entity, reviews, currentCriteria)
        }
    }
    ComparisonSnapshot(
        categoryId = query.categoryId,
        aggregation = query.aggregation,
        criteria = currentCriteria.map { criterion ->
            ProjectionCriterion(criterion.criterionId, criterion.name, criterion.position, missing = false)
        },
        entities = projections,
    )
}

private fun eligibleReviews(
    connection: Connection,
    entityId: UUID,
    query: ComparisonQuery,
) = connection.prepareStatement(
    """
    SELECT * FROM review
    WHERE entity_id = ?
      AND status = 'final'
      AND hidden_at IS NULL
      AND (? IS NULL OR reviewed_at >= ?)
      AND (? IS NULL OR reviewed_at <= ?)
      AND (? IS NULL OR reviewer_id = ?)
    ORDER BY reviewed_at DESC, created_at DESC, id DESC
    """.trimIndent(),
).use { statement ->
    statement.setString(1, entityId.toString())
    statement.setNullableString(2, query.from?.toDatabaseTimestamp())
    statement.setNullableString(3, query.from?.toDatabaseTimestamp())
    statement.setNullableString(4, query.to?.toDatabaseTimestamp())
    statement.setNullableString(5, query.to?.toDatabaseTimestamp())
    statement.setNullableString(6, query.reviewerId?.toString())
    statement.setNullableString(7, query.reviewerId?.toString())
    statement.executeQuery().use { result -> buildList { while (result.next()) add(result.toReview()) } }
}

private fun latestProjection(
    connection: Connection,
    entity: dev.reviewengine.domain.Entity,
    reviews: List<dev.reviewengine.domain.Review>,
    currentCriteria: List<TemplateCriterion>,
): ComparisonEntity {
    val latest = reviews.firstOrNull()
    val scoreMap = latest?.let { reviewSnapshot(connection, it).scores.associateBy { score -> score.criterionId } }.orEmpty()
    val criteria = currentCriteria.map { current ->
        scoreMap[current.criterionId]?.let { score ->
            ProjectionCriterion(
                criterionId = current.criterionId,
                name = current.name,
                position = current.position,
                missing = false,
                displayValue = score.displayValue,
                normalizedValue = score.normalizedValue,
                minValue = score.minValue,
                maxValue = score.maxValue,
                sampleCount = 1,
            )
        } ?: missing(current)
    }
    return ComparisonEntity(
        entity = entity,
        reviewCount = reviews.size,
        lastReviewedAt = latest?.reviewedAt,
        criteria = criteria,
        overallNormalizedValue = overall(criteria),
    )
}

private fun meanProjection(
    connection: Connection,
    entity: dev.reviewengine.domain.Entity,
    reviews: List<dev.reviewengine.domain.Review>,
    currentCriteria: List<TemplateCriterion>,
): ComparisonEntity {
    val scoresByCriterion = mutableMapOf<UUID, MutableList<BigDecimal>>()
    reviews.forEach { review ->
        reviewSnapshot(connection, review).scores.forEach { score ->
            scoresByCriterion.getOrPut(score.criterionId, ::mutableListOf).add(BigDecimal(score.normalizedValue))
        }
    }
    val criteria = currentCriteria.map { current ->
        val values = scoresByCriterion[current.criterionId].orEmpty()
        if (values.isEmpty()) {
            missing(current)
        } else {
            val mean = values.fold(BigDecimal.ZERO, BigDecimal::add)
                .divide(BigDecimal.valueOf(values.size.toLong()), MathContext.DECIMAL128)
            val display = current.scale.minValue + (current.scale.maxValue - current.scale.minValue).multiply(mean)
            ProjectionCriterion(
                criterionId = current.criterionId,
                name = current.name,
                position = current.position,
                missing = false,
                displayValue = display.canonical(),
                normalizedValue = mean.canonical(),
                minValue = current.scale.minValueString(),
                maxValue = current.scale.maxValueString(),
                sampleCount = values.size,
            )
        }
    }
    return ComparisonEntity(
        entity = entity,
        reviewCount = reviews.size,
        lastReviewedAt = reviews.firstOrNull()?.reviewedAt,
        criteria = criteria,
        overallNormalizedValue = overall(criteria),
    )
}

private fun historyProjection(
    connection: Connection,
    entity: dev.reviewengine.domain.Entity,
    reviews: List<dev.reviewengine.domain.Review>,
    currentCriteria: List<TemplateCriterion>,
): ComparisonEntity {
    val history = reviews.map { reviewSnapshot(connection, it) }
    val latest = latestProjection(connection, entity, reviews, currentCriteria)
    return latest.copy(history = history)
}

private fun missing(criterion: TemplateCriterion) = ProjectionCriterion(
    criterionId = criterion.criterionId,
    name = criterion.name,
    position = criterion.position,
    missing = true,
    minValue = criterion.scale.minValueString(),
    maxValue = criterion.scale.maxValueString(),
)

private fun overall(criteria: List<ProjectionCriterion>): String? {
    val values = criteria.mapNotNull { it.normalizedValue?.let(::BigDecimal) }
    if (values.isEmpty()) return null
    return values.fold(BigDecimal.ZERO, BigDecimal::add)
        .divide(BigDecimal.valueOf(values.size.toLong()), MathContext.DECIMAL128)
        .canonical()
}

private fun BigDecimal.canonical(): String = stripTrailingZeros().toPlainString()
