package dev.reviewengine.persistence

import dev.reviewengine.domain.DomainErrorCode
import dev.reviewengine.domain.DomainException
import dev.reviewengine.domain.DomainRules
import dev.reviewengine.domain.Review
import dev.reviewengine.domain.ReviewStatus
import dev.reviewengine.domain.ReviewWithScores
import dev.reviewengine.domain.Score
import java.sql.Connection
import java.sql.ResultSet
import java.time.Instant
import java.util.UUID

class ReviewRepository(
    private val templates: TemplateRepository = TemplateRepository(),
) {
    fun insert(connection: Connection, review: Review, scores: Collection<Score> = emptyList()) {
        requireScoresBelongToReview(review.id, scores)
        val definition = templates.getDefinition(connection, review.templateVersionId)
        val entityCategoryId = connection.prepareStatement("SELECT category_id FROM entity WHERE id = ?").use { statement ->
            statement.setUuid(1, review.entityId)
            statement.executeQuery().use { result ->
                if (!result.next()) notFound("Entity", review.entityId)
                result.uuid("category_id")
            }
        }
        if (entityCategoryId != definition.version.categoryId) {
            throw DomainException(
                DomainErrorCode.CATEGORY_MISMATCH,
                "Entity and template version must belong to the same category",
                mapOf(
                    "entityCategoryId" to entityCategoryId.toString(),
                    "templateCategoryId" to definition.version.categoryId.toString(),
                ),
            )
        }
        DomainRules.validateScores(definition, scores, review.status == ReviewStatus.FINAL)

        connection.prepareStatement(
            """INSERT INTO review
                (id, entity_id, reviewer_id, template_version_id, reviewed_at, status, supersedes_review_id,
                 created_at, updated_at, lock_version)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        ).use { statement ->
            statement.setUuid(1, review.id)
            statement.setUuid(2, review.entityId)
            statement.setUuid(3, review.reviewerId)
            statement.setUuid(4, review.templateVersionId)
            statement.setInstant(5, review.reviewedAt)
            statement.setString(6, review.status.databaseValue)
            statement.setNullableUuid(7, review.supersedesReviewId)
            statement.setInstant(8, review.createdAt)
            statement.setInstant(9, review.updatedAt)
            statement.setLong(10, review.lockVersion)
            statement.executeUpdate()
        }
        scores.forEach { insertScore(connection, it) }
    }

    fun findById(connection: Connection, id: UUID): Review? = connection.prepareStatement(
        "SELECT * FROM review WHERE id = ?",
    ).use { statement ->
        statement.setUuid(1, id)
        statement.executeQuery().use { result -> if (result.next()) result.toReview() else null }
    }

    fun getById(connection: Connection, id: UUID): Review = findById(connection, id) ?: notFound("Review", id)

    fun findWithScores(connection: Connection, id: UUID): ReviewWithScores? =
        findById(connection, id)?.let { ReviewWithScores(it, listScores(connection, id)) }

    fun getWithScores(connection: Connection, id: UUID): ReviewWithScores =
        findWithScores(connection, id) ?: notFound("Review", id)

    fun listForEntity(
        connection: Connection,
        entityId: UUID,
        includeDrafts: Boolean = true,
        includeSuperseded: Boolean = true,
    ): List<Review> {
        val excluded = buildList {
            if (!includeDrafts) add("draft")
            if (!includeSuperseded) add("superseded")
        }
        val placeholders = excluded.joinToString(",") { "?" }
        val sql = "SELECT * FROM review WHERE entity_id = ?" +
            if (excluded.isEmpty()) " ORDER BY reviewed_at DESC, id DESC"
            else " AND status NOT IN ($placeholders) ORDER BY reviewed_at DESC, id DESC"
        return connection.prepareStatement(sql).use { statement ->
            statement.setUuid(1, entityId)
            excluded.forEachIndexed { index, status -> statement.setString(index + 2, status) }
            statement.executeQuery().use { result -> result.mapRows { it.toReview() } }
        }
    }

    fun replaceDraftScores(
        connection: Connection,
        reviewId: UUID,
        expectedLockVersion: Long,
        scores: Collection<Score>,
        updatedAt: Instant,
    ): Review {
        val review = getById(connection, reviewId)
        DomainRules.requireReviewEditable(review)
        if (review.lockVersion != expectedLockVersion) optimisticLockFailure("Review", reviewId, expectedLockVersion)
        requireScoresBelongToReview(reviewId, scores)
        DomainRules.validateScores(templates.getDefinition(connection, review.templateVersionId), scores, false)
        replaceScores(connection, reviewId, scores)
        return touchDraft(connection, review, expectedLockVersion, updatedAt)
    }

    fun finalize(
        connection: Connection,
        reviewId: UUID,
        expectedLockVersion: Long,
        scores: Collection<Score>,
        updatedAt: Instant,
    ): Review {
        val review = getById(connection, reviewId)
        DomainRules.requireReviewEditable(review)
        if (review.lockVersion != expectedLockVersion) optimisticLockFailure("Review", reviewId, expectedLockVersion)
        requireScoresBelongToReview(reviewId, scores)
        DomainRules.validateScores(templates.getDefinition(connection, review.templateVersionId), scores, true)
        replaceScores(connection, reviewId, scores)
        val changed = connection.prepareStatement(
            """UPDATE review SET status = 'final', updated_at = ?, lock_version = lock_version + 1
                WHERE id = ? AND status = 'draft' AND lock_version = ?""",
        ).use { statement ->
            statement.setInstant(1, updatedAt)
            statement.setUuid(2, reviewId)
            statement.setLong(3, expectedLockVersion)
            statement.executeUpdate()
        }
        if (changed != 1) optimisticLockFailure("Review", reviewId, expectedLockVersion)
        return review.copy(status = ReviewStatus.FINAL, updatedAt = updatedAt, lockVersion = expectedLockVersion + 1)
    }

    fun supersede(
        connection: Connection,
        reviewId: UUID,
        expectedLockVersion: Long,
        updatedAt: Instant,
    ): Review {
        val review = getById(connection, reviewId)
        if (review.status != ReviewStatus.FINAL) {
            throw DomainException(
                DomainErrorCode.INVALID_STATE_TRANSITION,
                "Only a final review can be superseded",
                mapOf("reviewId" to reviewId.toString()),
            )
        }
        val changed = connection.prepareStatement(
            """UPDATE review SET status = 'superseded', updated_at = ?, lock_version = lock_version + 1
                WHERE id = ? AND status = 'final' AND lock_version = ?""",
        ).use { statement ->
            statement.setInstant(1, updatedAt)
            statement.setUuid(2, reviewId)
            statement.setLong(3, expectedLockVersion)
            statement.executeUpdate()
        }
        if (changed != 1) optimisticLockFailure("Review", reviewId, expectedLockVersion)
        return review.copy(status = ReviewStatus.SUPERSEDED, updatedAt = updatedAt, lockVersion = expectedLockVersion + 1)
    }

    fun listScores(connection: Connection, reviewId: UUID): List<Score> = connection.prepareStatement(
        "SELECT * FROM score WHERE review_id = ? ORDER BY criterion_id",
    ).use { statement ->
        statement.setUuid(1, reviewId)
        statement.executeQuery().use { result ->
            result.mapRows { Score(it.uuid("review_id"), it.uuid("criterion_id"), it.getLong("tick_index")) }
        }
    }

    private fun replaceScores(connection: Connection, reviewId: UUID, scores: Collection<Score>) {
        connection.prepareStatement("DELETE FROM score WHERE review_id = ?").use { statement ->
            statement.setUuid(1, reviewId)
            statement.executeUpdate()
        }
        scores.forEach { insertScore(connection, it) }
    }

    private fun insertScore(connection: Connection, score: Score) {
        connection.prepareStatement("INSERT INTO score(review_id, criterion_id, tick_index) VALUES (?, ?, ?)").use { statement ->
            statement.setUuid(1, score.reviewId)
            statement.setUuid(2, score.criterionId)
            statement.setLong(3, score.tickIndex)
            statement.executeUpdate()
        }
    }

    private fun touchDraft(connection: Connection, review: Review, expected: Long, updatedAt: Instant): Review {
        val changed = connection.prepareStatement(
            """UPDATE review SET updated_at = ?, lock_version = lock_version + 1
                WHERE id = ? AND status = 'draft' AND lock_version = ?""",
        ).use { statement ->
            statement.setInstant(1, updatedAt)
            statement.setUuid(2, review.id)
            statement.setLong(3, expected)
            statement.executeUpdate()
        }
        if (changed != 1) optimisticLockFailure("Review", review.id, expected)
        return review.copy(updatedAt = updatedAt, lockVersion = expected + 1)
    }

    private fun requireScoresBelongToReview(reviewId: UUID, scores: Collection<Score>) {
        if (scores.any { it.reviewId != reviewId }) {
            throw DomainException(
                DomainErrorCode.CONFLICT,
                "Every score must belong to its review",
                mapOf("reviewId" to reviewId.toString()),
            )
        }
    }

    private fun ResultSet.toReview() = Review(
        id = uuid("id"),
        entityId = uuid("entity_id"),
        reviewerId = uuid("reviewer_id"),
        templateVersionId = uuid("template_version_id"),
        reviewedAt = instant("reviewed_at"),
        status = ReviewStatus.fromDatabase(getString("status")),
        supersedesReviewId = nullableUuid("supersedes_review_id"),
        createdAt = instant("created_at"),
        updatedAt = instant("updated_at"),
        lockVersion = getLong("lock_version"),
    )
}
