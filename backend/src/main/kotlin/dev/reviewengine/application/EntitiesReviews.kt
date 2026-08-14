package dev.reviewengine.application

import dev.reviewengine.domain.DomainErrorCode
import dev.reviewengine.domain.DomainException
import dev.reviewengine.domain.DomainRules
import dev.reviewengine.domain.Entity
import dev.reviewengine.domain.Review
import dev.reviewengine.domain.ReviewStatus
import dev.reviewengine.domain.Score
import dev.reviewengine.domain.TemplateDefinition
import dev.reviewengine.domain.TemplateStatus
import dev.reviewengine.persistence.toDatabaseTimestamp
import java.sql.Connection
import java.time.Instant
import java.util.UUID

fun ReviewEngine.listEntities(
    categoryId: UUID? = null,
    query: String? = null,
    includeArchived: Boolean = false,
    cursor: String? = null,
    limit: Int? = null,
): Page<EntitySnapshot> = database.read { connection ->
    val offset = decodeCursor(cursor)
    val pageSize = normalizeLimit(limit)
    val normalizedQuery = query?.trim()?.lowercase()?.takeIf(String::isNotEmpty)
    connection.prepareStatement(
        """
        SELECT e.*, c.name AS category_name,
               (SELECT COUNT(*) FROM review r WHERE r.entity_id = e.id) AS review_count,
               (SELECT MAX(r.reviewed_at) FROM review r WHERE r.entity_id = e.id AND r.status = 'final') AS latest_reviewed_at
        FROM entity e
        JOIN category c ON c.id = e.category_id
        WHERE (? = 1 OR e.archived_at IS NULL)
          AND (? IS NULL OR e.category_id = ?)
          AND (? IS NULL OR lower(e.name) LIKE '%' || ? || '%')
        ORDER BY lower(e.name), e.id
        LIMIT ? OFFSET ?
        """.trimIndent(),
    ).use { statement ->
        statement.setInt(1, if (includeArchived) 1 else 0)
        statement.setNullableString(2, categoryId?.toString())
        statement.setNullableString(3, categoryId?.toString())
        statement.setNullableString(4, normalizedQuery)
        statement.setNullableString(5, normalizedQuery)
        statement.setInt(6, pageSize + 1)
        statement.setInt(7, offset)
        statement.executeQuery().use { result ->
            val rows = buildList {
                while (result.next()) {
                    add(
                        EntitySnapshot(
                            entity = result.toEntity(),
                            categoryName = result.getString("category_name"),
                            reviewCount = result.getLong("review_count"),
                            latestReviewedAt = result.getString("latest_reviewed_at")?.let(Instant::parse),
                        ),
                    )
                }
            }
            Page(rows.take(pageSize), if (rows.size > pageSize) encodeCursor(offset + pageSize) else null)
        }
    }
}

fun ReviewEngine.getEntity(id: UUID): EntitySnapshot = database.read { connection -> entitySnapshot(connection, id) }

fun ReviewEngine.createEntity(categoryId: UUID, name: String, description: String?): EntitySnapshot = mapSqlConflict {
    database.write { connection ->
        val category = connection.category(categoryId)
        if (category.archivedAt != null) conflict("Archived categories cannot receive new entities", "categoryId" to categoryId)
        val id = newId()
        val now = now()
        connection.prepareStatement(
            """
            INSERT INTO entity(id, category_id, name, description, archived_at, created_at, updated_at, lock_version)
            VALUES (?, ?, ?, ?, NULL, ?, ?, 0)
            """.trimIndent(),
        ).use { statement ->
            statement.setString(1, id.toString())
            statement.setString(2, categoryId.toString())
            statement.setString(3, requireNonBlank(name, "name"))
            statement.setNullableString(4, description?.trim()?.takeIf(String::isNotEmpty))
            statement.setString(5, now.toDatabaseTimestamp())
            statement.setString(6, now.toDatabaseTimestamp())
            statement.executeUpdate()
        }
        entitySnapshot(connection, id)
    }
}

fun ReviewEngine.updateEntity(id: UUID, update: EntityUpdate): EntitySnapshot = mapSqlConflict {
    database.write { connection ->
        val current = connection.entity(id)
        update.expectedLockVersion?.let { expected ->
            if (current.lockVersion != expected) optimisticConflict("Entity", id, expected, current.lockVersion)
        }
        val categoryId = update.categoryId ?: current.categoryId
        if (categoryId != current.categoryId) {
            val reviewCount = connection.prepareStatement("SELECT COUNT(*) FROM review WHERE entity_id = ?").use { statement ->
                statement.setString(1, id.toString())
                statement.executeQuery().use { result -> result.next(); result.getLong(1) }
            }
            if (reviewCount > 0) conflict("An entity with review history cannot change category", "entityId" to id)
            val category = connection.category(categoryId)
            if (category.archivedAt != null) conflict("An entity cannot move to an archived category", "categoryId" to categoryId)
        }
        val name = update.name?.let { requireNonBlank(it, "name") } ?: current.name
        val description = if (update.descriptionSpecified) update.description?.trim()?.takeIf(String::isNotEmpty) else current.description
        val archivedAt = when (update.archived) {
            true -> current.archivedAt ?: now()
            false -> null
            null -> current.archivedAt
        }
        connection.prepareStatement(
            """
            UPDATE entity
            SET category_id = ?, name = ?, description = ?, archived_at = ?, updated_at = ?, lock_version = lock_version + 1
            WHERE id = ? AND lock_version = ?
            """.trimIndent(),
        ).use { statement ->
            statement.setString(1, categoryId.toString())
            statement.setString(2, name)
            statement.setNullableString(3, description)
            statement.setNullableString(4, archivedAt?.toDatabaseTimestamp())
            statement.setString(5, now().toDatabaseTimestamp())
            statement.setString(6, id.toString())
            statement.setLong(7, current.lockVersion)
            if (statement.executeUpdate() != 1) optimisticConflict("Entity", id, current.lockVersion, null)
        }
        entitySnapshot(connection, id)
    }
}

fun ReviewEngine.deleteEntity(id: UUID) = mapSqlConflict {
    database.write { connection ->
        connection.entity(id)
        connection.prepareStatement("DELETE FROM entity WHERE id = ?").use { statement ->
            statement.setString(1, id.toString())
            statement.executeUpdate()
        }
        Unit
    }
}

fun ReviewEngine.listReviews(
    entityId: UUID,
    includeSuperseded: Boolean = false,
    cursor: String? = null,
    limit: Int? = null,
): Page<ReviewSnapshot> = database.read { connection ->
    connection.entity(entityId)
    val offset = decodeCursor(cursor)
    val pageSize = normalizeLimit(limit)
    connection.prepareStatement(
        """
        SELECT * FROM review
        WHERE entity_id = ? AND (? = 1 OR status <> 'superseded')
        ORDER BY reviewed_at DESC, created_at DESC, id DESC
        LIMIT ? OFFSET ?
        """.trimIndent(),
    ).use { statement ->
        statement.setString(1, entityId.toString())
        statement.setInt(2, if (includeSuperseded) 1 else 0)
        statement.setInt(3, pageSize + 1)
        statement.setInt(4, offset)
        statement.executeQuery().use { result ->
            val reviews = buildList { while (result.next()) add(result.toReview()) }
            Page(
                items = reviews.take(pageSize).map { review -> reviewSnapshot(connection, review) },
                nextCursor = if (reviews.size > pageSize) encodeCursor(offset + pageSize) else null,
            )
        }
    }
}

fun ReviewEngine.getReview(id: UUID): ReviewSnapshot = database.read { connection ->
    reviewSnapshot(connection, connection.review(id))
}

fun ReviewEngine.createReview(entityId: UUID, write: ReviewWrite): ReviewSnapshot = mapSqlConflict {
    database.write { connection ->
        val entity = connection.entity(entityId)
        if (entity.archivedAt != null) conflict("Archived entities cannot receive new reviews", "entityId" to entityId)
        val category = connection.category(entity.categoryId)
        val templateId = category.activeTemplateVersionId
            ?: conflict("The entity category has no active template", "categoryId" to category.id)
        val template = connection.templateVersion(templateId)
        if (template.status != TemplateStatus.PUBLISHED) conflict("The active template is not published", "templateVersionId" to templateId)
        requireActiveReviewer(connection, write.reviewerId)
        val id = newId()
        val scores = write.scores.map { Score(id, it.criterionId, it.tickIndex) }
        DomainRules.validateScores(
            TemplateDefinition(template, connection.templateCriteria(templateId)),
            scores,
            requireComplete = write.finalize,
        )
        val now = now()
        val status = if (write.finalize) ReviewStatus.FINAL else ReviewStatus.DRAFT
        insertReview(connection, Review(id, entityId, write.reviewerId, templateId, write.reviewedAt, status, null, now, now), scores)
        reviewSnapshot(connection, connection.review(id))
    }
}

fun ReviewEngine.updateReview(id: UUID, write: ReviewWrite): ReviewSnapshot = mapSqlConflict {
    database.write { connection ->
        val review = connection.review(id)
        DomainRules.requireReviewEditable(review)
        val expectedLockVersion = write.expectedLockVersion
            ?: throw DomainException(DomainErrorCode.INVALID_ARGUMENT, "revision is required when updating a draft review")
        if (review.lockVersion != expectedLockVersion) {
            optimisticConflict("Review", id, expectedLockVersion, review.lockVersion)
        }
        requireActiveReviewer(connection, write.reviewerId)
        val template = connection.templateVersion(review.templateVersionId)
        val scores = write.scores.map { Score(id, it.criterionId, it.tickIndex) }
        DomainRules.validateScores(
            TemplateDefinition(template, connection.templateCriteria(template.id)),
            scores,
            requireComplete = write.finalize,
        )
        replaceScores(connection, id, scores)
        connection.prepareStatement(
            """
            UPDATE review
            SET reviewer_id = ?, reviewed_at = ?, status = ?, updated_at = ?, lock_version = lock_version + 1
            WHERE id = ? AND status = 'draft' AND lock_version = ?
            """.trimIndent(),
        ).use { statement ->
            statement.setString(1, write.reviewerId.toString())
            statement.setString(2, write.reviewedAt.toDatabaseTimestamp())
            statement.setString(3, if (write.finalize) ReviewStatus.FINAL.databaseValue else ReviewStatus.DRAFT.databaseValue)
            statement.setString(4, now().toDatabaseTimestamp())
            statement.setString(5, id.toString())
            statement.setLong(6, review.lockVersion)
            if (statement.executeUpdate() != 1) optimisticConflict("Review", id, review.lockVersion, null)
        }
        reviewSnapshot(connection, connection.review(id))
    }
}

fun ReviewEngine.finalizeReview(
    id: UUID,
    expectedLockVersion: Long,
    replacementScores: List<ScoreInput>? = null,
): ReviewSnapshot = mapSqlConflict {
    database.write { connection ->
        val review = connection.review(id)
        DomainRules.requireReviewEditable(review)
        if (review.lockVersion != expectedLockVersion) {
            optimisticConflict("Review", id, expectedLockVersion, review.lockVersion)
        }
        val template = connection.templateVersion(review.templateVersionId)
        if (replacementScores != null) {
            val scores = replacementScores.map { Score(id, it.criterionId, it.tickIndex) }
            DomainRules.validateScores(TemplateDefinition(template, connection.templateCriteria(template.id)), scores, requireComplete = true)
            replaceScores(connection, id, scores)
        } else {
            val scores = readScores(connection, id)
            DomainRules.validateScores(TemplateDefinition(template, connection.templateCriteria(template.id)), scores, requireComplete = true)
        }
        connection.prepareStatement(
            """
            UPDATE review SET status = 'final', updated_at = ?, lock_version = lock_version + 1
            WHERE id = ? AND status = 'draft' AND lock_version = ?
            """.trimIndent(),
        ).use { statement ->
            statement.setString(1, now().toDatabaseTimestamp())
            statement.setString(2, id.toString())
            statement.setLong(3, expectedLockVersion)
            if (statement.executeUpdate() != 1) optimisticConflict("Review", id, expectedLockVersion, null)
        }
        reviewSnapshot(connection, connection.review(id))
    }
}

fun ReviewEngine.reviseReview(id: UUID, write: ReviewWrite): ReviewSnapshot = mapSqlConflict {
    database.write { connection ->
        val original = connection.review(id)
        if (original.status != ReviewStatus.FINAL) {
            throw DomainException(DomainErrorCode.INVALID_STATE_TRANSITION, "Only a final review can be revised")
        }
        val expectedLockVersion = write.expectedLockVersion
            ?: throw DomainException(DomainErrorCode.INVALID_ARGUMENT, "revision is required when correcting a review")
        if (original.lockVersion != expectedLockVersion) {
            optimisticConflict("Review", id, expectedLockVersion, original.lockVersion)
        }
        requireActiveReviewer(connection, write.reviewerId)
        val template = connection.templateVersion(original.templateVersionId)
        val replacementId = newId()
        val scores = write.scores.map { Score(replacementId, it.criterionId, it.tickIndex) }
        DomainRules.validateScores(TemplateDefinition(template, connection.templateCriteria(template.id)), scores, requireComplete = true)
        val now = now()
        insertReview(
            connection,
            Review(
                replacementId,
                original.entityId,
                write.reviewerId,
                original.templateVersionId,
                write.reviewedAt,
                ReviewStatus.FINAL,
                original.id,
                now,
                now,
            ),
            scores,
        )
        connection.prepareStatement(
            """
            UPDATE review SET status = 'superseded', updated_at = ?, lock_version = lock_version + 1
            WHERE id = ? AND status = 'final' AND lock_version = ?
            """.trimIndent(),
        ).use { statement ->
            statement.setString(1, now.toDatabaseTimestamp())
            statement.setString(2, original.id.toString())
            statement.setLong(3, expectedLockVersion)
            if (statement.executeUpdate() != 1) optimisticConflict("Review", id, expectedLockVersion, null)
        }
        reviewSnapshot(connection, connection.review(replacementId))
    }
}

fun ReviewEngine.deleteDraftReview(id: UUID, expectedLockVersion: Long) = mapSqlConflict {
    database.write { connection ->
        val review = connection.review(id)
        DomainRules.requireReviewEditable(review)
        if (review.lockVersion != expectedLockVersion) {
            optimisticConflict("Review", id, expectedLockVersion, review.lockVersion)
        }
        connection.prepareStatement("DELETE FROM review WHERE id = ? AND status = 'draft' AND lock_version = ?").use { statement ->
            statement.setString(1, id.toString())
            statement.setLong(2, expectedLockVersion)
            if (statement.executeUpdate() != 1) optimisticConflict("Review", id, expectedLockVersion, null)
        }
        Unit
    }
}

private fun entitySnapshot(connection: Connection, id: UUID): EntitySnapshot = connection.prepareStatement(
    """
    SELECT e.*, c.name AS category_name,
           (SELECT COUNT(*) FROM review r WHERE r.entity_id = e.id) AS review_count,
           (SELECT MAX(r.reviewed_at) FROM review r WHERE r.entity_id = e.id AND r.status = 'final') AS latest_reviewed_at
    FROM entity e JOIN category c ON c.id = e.category_id WHERE e.id = ?
    """.trimIndent(),
).use { statement ->
    statement.setString(1, id.toString())
    statement.executeQuery().use { result ->
        if (!result.next()) notFound("Entity", id)
        EntitySnapshot(
            result.toEntity(),
            result.getString("category_name"),
            result.getLong("review_count"),
            result.getString("latest_reviewed_at")?.let(Instant::parse),
        )
    }
}

internal fun reviewSnapshot(connection: Connection, review: Review): ReviewSnapshot {
    val metadata = connection.prepareStatement(
        """
        SELECT rv.display_name, tv.version
        FROM reviewer rv, template_version tv
        WHERE rv.id = ? AND tv.id = ?
        """.trimIndent(),
    ).use { statement ->
        statement.setString(1, review.reviewerId.toString())
        statement.setString(2, review.templateVersionId.toString())
        statement.executeQuery().use { result ->
            if (!result.next()) conflict("Review metadata is incomplete", "reviewId" to review.id)
            result.getString(1) to result.getInt(2)
        }
    }
    val scores = connection.prepareStatement(
        """
        SELECT s.criterion_id, s.tick_index, tc.name, tc.min_value, tc.max_value, tc.step_value
        FROM score s
        JOIN template_criterion tc
          ON tc.template_version_id = ? AND tc.criterion_id = s.criterion_id
        WHERE s.review_id = ?
        ORDER BY tc.position, s.criterion_id
        """.trimIndent(),
    ).use { statement ->
        statement.setString(1, review.templateVersionId.toString())
        statement.setString(2, review.id.toString())
        statement.executeQuery().use { result ->
            buildList {
                while (result.next()) {
                    val tick = result.getLong("tick_index")
                    val scale = dev.reviewengine.domain.Scale.of(
                        result.getString("min_value"),
                        result.getString("max_value"),
                        result.getString("step_value"),
                    )
                    add(
                        ScoreSnapshot(
                            criterionId = UUID.fromString(result.getString("criterion_id")),
                            criterionName = result.getString("name"),
                            tickIndex = tick,
                            displayValue = scale.displayString(tick),
                            normalizedValue = scale.normalizedString(tick),
                            minValue = scale.minValueString(),
                            maxValue = scale.maxValueString(),
                            stepValue = scale.stepValueString(),
                        ),
                    )
                }
            }
        }
    }
    return ReviewSnapshot(review, metadata.first, metadata.second, scores)
}

private fun requireActiveReviewer(connection: Connection, reviewerId: UUID) {
    val active = connection.prepareStatement("SELECT archived_at IS NULL FROM reviewer WHERE id = ?").use { statement ->
        statement.setString(1, reviewerId.toString())
        statement.executeQuery().use { result -> if (result.next()) result.getInt(1) != 0 else notFound("Reviewer", reviewerId) }
    }
    if (!active) conflict("Archived reviewers cannot write reviews", "reviewerId" to reviewerId)
}

private fun insertReview(connection: Connection, review: Review, scores: List<Score>) {
    connection.prepareStatement(
        """
        INSERT INTO review(
            id, entity_id, reviewer_id, template_version_id, reviewed_at, status,
            supersedes_review_id, created_at, updated_at, lock_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        """.trimIndent(),
    ).use { statement ->
        statement.setString(1, review.id.toString())
        statement.setString(2, review.entityId.toString())
        statement.setString(3, review.reviewerId.toString())
        statement.setString(4, review.templateVersionId.toString())
        statement.setString(5, review.reviewedAt.toDatabaseTimestamp())
        statement.setString(6, review.status.databaseValue)
        statement.setNullableString(7, review.supersedesReviewId?.toString())
        statement.setString(8, review.createdAt.toDatabaseTimestamp())
        statement.setString(9, review.updatedAt.toDatabaseTimestamp())
        statement.executeUpdate()
    }
    replaceScores(connection, review.id, scores)
}

private fun replaceScores(connection: Connection, reviewId: UUID, scores: List<Score>) {
    connection.prepareStatement("DELETE FROM score WHERE review_id = ?").use { statement ->
        statement.setString(1, reviewId.toString())
        statement.executeUpdate()
    }
    connection.prepareStatement("INSERT INTO score(review_id, criterion_id, tick_index) VALUES (?, ?, ?)").use { statement ->
        scores.forEach { score ->
            statement.setString(1, reviewId.toString())
            statement.setString(2, score.criterionId.toString())
            statement.setLong(3, score.tickIndex)
            statement.addBatch()
        }
        statement.executeBatch()
    }
}

private fun readScores(connection: Connection, reviewId: UUID): List<Score> = connection.prepareStatement(
    "SELECT criterion_id, tick_index FROM score WHERE review_id = ?",
).use { statement ->
    statement.setString(1, reviewId.toString())
    statement.executeQuery().use { result ->
        buildList {
            while (result.next()) add(Score(reviewId, UUID.fromString(result.getString(1)), result.getLong(2)))
        }
    }
}
