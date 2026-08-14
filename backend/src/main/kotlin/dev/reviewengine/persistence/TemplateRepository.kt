package dev.reviewengine.persistence

import dev.reviewengine.domain.Criterion
import dev.reviewengine.domain.DomainErrorCode
import dev.reviewengine.domain.DomainException
import dev.reviewengine.domain.DomainRules
import dev.reviewengine.domain.Scale
import dev.reviewengine.domain.TemplateCriterion
import dev.reviewengine.domain.TemplateDefinition
import dev.reviewengine.domain.TemplateStatus
import dev.reviewengine.domain.TemplateVersion
import java.sql.Connection
import java.sql.ResultSet
import java.time.Instant
import java.util.UUID

class TemplateRepository {
    fun insertCriterion(connection: Connection, criterion: Criterion) {
        connection.prepareStatement("INSERT INTO criterion(id, category_id, created_at) VALUES (?, ?, ?)").use { statement ->
            statement.setUuid(1, criterion.id)
            statement.setUuid(2, criterion.categoryId)
            statement.setInstant(3, criterion.createdAt)
            statement.executeUpdate()
        }
    }

    fun insertVersion(connection: Connection, version: TemplateVersion) {
        connection.prepareStatement(
            """INSERT INTO template_version
                (id, category_id, version, status, published_at, created_at, updated_at, lock_version)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        ).use { statement ->
            statement.setUuid(1, version.id)
            statement.setUuid(2, version.categoryId)
            statement.setInt(3, version.version)
            statement.setString(4, version.status.databaseValue)
            statement.setNullableInstant(5, version.publishedAt)
            statement.setInstant(6, version.createdAt)
            statement.setInstant(7, version.updatedAt)
            statement.setLong(8, version.lockVersion)
            statement.executeUpdate()
        }
    }

    fun insertTemplateCriterion(connection: Connection, criterion: TemplateCriterion) {
        connection.prepareStatement(
            """INSERT INTO template_criterion
                (template_version_id, criterion_id, name, description, min_value, max_value, step_value, position, required)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        ).use { statement ->
            statement.setUuid(1, criterion.templateVersionId)
            statement.setUuid(2, criterion.criterionId)
            statement.setString(3, criterion.name)
            statement.setString(4, criterion.description)
            statement.setString(5, criterion.scale.minValueString())
            statement.setString(6, criterion.scale.maxValueString())
            statement.setString(7, criterion.scale.stepValueString())
            statement.setInt(8, criterion.position)
            statement.setInt(9, if (criterion.required) 1 else 0)
            statement.executeUpdate()
        }
    }

    fun replaceDraftCriteria(
        connection: Connection,
        versionId: UUID,
        expectedLockVersion: Long,
        updatedAt: Instant,
        criteria: List<TemplateCriterion>,
    ): TemplateVersion {
        val current = getVersion(connection, versionId)
        DomainRules.requireTemplateEditable(current)
        if (current.lockVersion != expectedLockVersion) {
            optimisticLockFailure("Template version", versionId, expectedLockVersion)
        }
        TemplateDefinition(current, criteria)

        connection.prepareStatement("DELETE FROM template_criterion WHERE template_version_id = ?").use { statement ->
            statement.setUuid(1, versionId)
            statement.executeUpdate()
        }
        criteria.forEach { insertTemplateCriterion(connection, it) }
        val changed = connection.prepareStatement(
            """UPDATE template_version SET updated_at = ?, lock_version = lock_version + 1
                WHERE id = ? AND status = 'draft' AND lock_version = ?""",
        ).use { statement ->
            statement.setInstant(1, updatedAt)
            statement.setUuid(2, versionId)
            statement.setLong(3, expectedLockVersion)
            statement.executeUpdate()
        }
        if (changed != 1) optimisticLockFailure("Template version", versionId, expectedLockVersion)
        return current.copy(updatedAt = updatedAt, lockVersion = expectedLockVersion + 1)
    }

    fun findVersion(connection: Connection, id: UUID): TemplateVersion? = connection.prepareStatement(
        "SELECT * FROM template_version WHERE id = ?",
    ).use { statement ->
        statement.setUuid(1, id)
        statement.executeQuery().use { result -> if (result.next()) result.toTemplateVersion() else null }
    }

    fun getVersion(connection: Connection, id: UUID): TemplateVersion =
        findVersion(connection, id) ?: notFound("Template version", id)

    fun findDefinition(connection: Connection, id: UUID): TemplateDefinition? {
        val version = findVersion(connection, id) ?: return null
        return TemplateDefinition(version, listCriteria(connection, id))
    }

    fun getDefinition(connection: Connection, id: UUID): TemplateDefinition =
        findDefinition(connection, id) ?: notFound("Template version", id)

    fun findActiveForCategory(connection: Connection, categoryId: UUID): TemplateDefinition? = connection.prepareStatement(
        """SELECT tv.id FROM category c JOIN template_version tv ON tv.id = c.active_template_version_id
            WHERE c.id = ? AND tv.status = 'published'""",
    ).use { statement ->
        statement.setUuid(1, categoryId)
        statement.executeQuery().use { result ->
            if (result.next()) getDefinition(connection, result.uuid("id")) else null
        }
    }

    fun listVersions(connection: Connection, categoryId: UUID): List<TemplateVersion> = connection.prepareStatement(
        "SELECT * FROM template_version WHERE category_id = ? ORDER BY version DESC",
    ).use { statement ->
        statement.setUuid(1, categoryId)
        statement.executeQuery().use { result -> result.mapRows { it.toTemplateVersion() } }
    }

    fun nextVersion(connection: Connection, categoryId: UUID): Int = connection.prepareStatement(
        "SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM template_version WHERE category_id = ?",
    ).use { statement ->
        statement.setUuid(1, categoryId)
        statement.executeQuery().use { result -> result.next(); result.getInt("next_version") }
    }

    /** Publishes a draft and changes the category's active version in the caller's transaction. */
    fun publish(
        connection: Connection,
        versionId: UUID,
        expectedLockVersion: Long,
        publishedAt: Instant,
    ): TemplateVersion {
        val definition = getDefinition(connection, versionId)
        DomainRules.requireTemplatePublishable(definition)
        if (definition.version.lockVersion != expectedLockVersion) {
            optimisticLockFailure("Template version", versionId, expectedLockVersion)
        }

        connection.prepareStatement(
            """UPDATE template_version SET status = 'retired', updated_at = ?, lock_version = lock_version + 1
                WHERE id = (SELECT active_template_version_id FROM category WHERE id = ?)
                  AND id <> ? AND status = 'published'""",
        ).use { statement ->
            statement.setInstant(1, publishedAt)
            statement.setUuid(2, definition.version.categoryId)
            statement.setUuid(3, versionId)
            statement.executeUpdate()
        }
        val changed = connection.prepareStatement(
            """UPDATE template_version SET status = 'published', published_at = ?, updated_at = ?, lock_version = lock_version + 1
                WHERE id = ? AND status = 'draft' AND lock_version = ?""",
        ).use { statement ->
            statement.setInstant(1, publishedAt)
            statement.setInstant(2, publishedAt)
            statement.setUuid(3, versionId)
            statement.setLong(4, expectedLockVersion)
            statement.executeUpdate()
        }
        if (changed != 1) optimisticLockFailure("Template version", versionId, expectedLockVersion)

        val categoryChanged = connection.prepareStatement(
            """UPDATE category SET active_template_version_id = ?, updated_at = ?, lock_version = lock_version + 1
                WHERE id = ?""",
        ).use { statement ->
            statement.setUuid(1, versionId)
            statement.setInstant(2, publishedAt)
            statement.setUuid(3, definition.version.categoryId)
            statement.executeUpdate()
        }
        if (categoryChanged != 1) notFound("Category", definition.version.categoryId)
        return definition.version.copy(
            status = TemplateStatus.PUBLISHED,
            publishedAt = publishedAt,
            updatedAt = publishedAt,
            lockVersion = expectedLockVersion + 1,
        )
    }

    fun retire(connection: Connection, versionId: UUID, expectedLockVersion: Long, updatedAt: Instant): TemplateVersion {
        val current = getVersion(connection, versionId)
        if (current.status != TemplateStatus.PUBLISHED) {
            throw DomainException(
                DomainErrorCode.INVALID_STATE_TRANSITION,
                "Only a published template version can be retired",
                mapOf("templateVersionId" to versionId.toString()),
            )
        }
        val changed = connection.prepareStatement(
            """UPDATE template_version SET status = 'retired', updated_at = ?, lock_version = lock_version + 1
                WHERE id = ? AND status = 'published' AND lock_version = ?""",
        ).use { statement ->
            statement.setInstant(1, updatedAt)
            statement.setUuid(2, versionId)
            statement.setLong(3, expectedLockVersion)
            statement.executeUpdate()
        }
        if (changed != 1) optimisticLockFailure("Template version", versionId, expectedLockVersion)
        return current.copy(status = TemplateStatus.RETIRED, updatedAt = updatedAt, lockVersion = expectedLockVersion + 1)
    }

    private fun listCriteria(connection: Connection, versionId: UUID): List<TemplateCriterion> = connection.prepareStatement(
        "SELECT * FROM template_criterion WHERE template_version_id = ? ORDER BY position, criterion_id",
    ).use { statement ->
        statement.setUuid(1, versionId)
        statement.executeQuery().use { result ->
            result.mapRows {
                TemplateCriterion(
                    templateVersionId = it.uuid("template_version_id"),
                    criterionId = it.uuid("criterion_id"),
                    name = it.getString("name"),
                    description = it.getString("description"),
                    scale = Scale.of(it.getString("min_value"), it.getString("max_value"), it.getString("step_value")),
                    position = it.getInt("position"),
                    required = it.getInt("required") == 1,
                )
            }
        }
    }

    private fun ResultSet.toTemplateVersion() = TemplateVersion(
        id = uuid("id"),
        categoryId = uuid("category_id"),
        version = getInt("version"),
        status = TemplateStatus.fromDatabase(getString("status")),
        publishedAt = nullableInstant("published_at"),
        createdAt = instant("created_at"),
        updatedAt = instant("updated_at"),
        lockVersion = getLong("lock_version"),
    )
}
