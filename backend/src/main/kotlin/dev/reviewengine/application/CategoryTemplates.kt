package dev.reviewengine.application

import dev.reviewengine.domain.Category
import dev.reviewengine.domain.DomainErrorCode
import dev.reviewengine.domain.DomainException
import dev.reviewengine.domain.TemplateStatus
import dev.reviewengine.persistence.toDatabaseTimestamp
import java.sql.Connection
import java.util.UUID

fun ReviewEngine.listCategories(
    cursor: String? = null,
    includeArchived: Boolean = false,
    limit: Int? = null,
): Page<Category> = database.read { connection ->
    val offset = decodeCursor(cursor)
    val pageSize = normalizeLimit(limit)
    val where = if (includeArchived) "" else "WHERE archived_at IS NULL"
    connection.prepareStatement(
        "SELECT * FROM category $where ORDER BY lower(name), id LIMIT ? OFFSET ?",
    ).use { statement ->
        statement.setInt(1, pageSize + 1)
        statement.setInt(2, offset)
        statement.executeQuery().use { result ->
            val rows = buildList { while (result.next()) add(result.toCategory()) }
            Page(rows.take(pageSize), if (rows.size > pageSize) encodeCursor(offset + pageSize) else null)
        }
    }
}

fun ReviewEngine.getCategory(id: UUID): Category = database.read { it.category(id) }

fun ReviewEngine.createCategory(name: String, description: String?): Category = mapSqlConflict {
    database.write { connection ->
        val id = newId()
        val now = now()
        connection.prepareStatement(
            """
            INSERT INTO category(id, name, description, active_template_version_id, archived_at, created_at, updated_at, lock_version)
            VALUES (?, ?, ?, NULL, NULL, ?, ?, 0)
            """.trimIndent(),
        ).use { statement ->
            statement.setString(1, id.toString())
            statement.setString(2, requireNonBlank(name, "name"))
            statement.setNullableString(3, description?.trim()?.takeIf(String::isNotEmpty))
            statement.setString(4, now.toDatabaseTimestamp())
            statement.setString(5, now.toDatabaseTimestamp())
            statement.executeUpdate()
        }
        connection.category(id)
    }
}

fun ReviewEngine.updateCategory(id: UUID, update: CategoryUpdate): Category = mapSqlConflict {
    database.write { connection ->
        val current = connection.category(id)
        update.expectedLockVersion?.let { expected ->
            if (current.lockVersion != expected) optimisticConflict("Category", id, expected, current.lockVersion)
        }
        val name = update.name?.let { requireNonBlank(it, "name") } ?: current.name
        val description = if (update.descriptionSpecified) update.description?.trim()?.takeIf(String::isNotEmpty) else current.description
        val archivedAt = when (update.archived) {
            true -> current.archivedAt ?: now()
            false -> null
            null -> current.archivedAt
        }
        val changed = name != current.name || description != current.description || archivedAt != current.archivedAt
        if (!changed) return@write current
        connection.prepareStatement(
            """
            UPDATE category
            SET name = ?, description = ?, archived_at = ?, updated_at = ?, lock_version = lock_version + 1
            WHERE id = ? AND lock_version = ?
            """.trimIndent(),
        ).use { statement ->
            statement.setString(1, name)
            statement.setNullableString(2, description)
            statement.setNullableString(3, archivedAt?.toDatabaseTimestamp())
            statement.setString(4, now().toDatabaseTimestamp())
            statement.setString(5, id.toString())
            statement.setLong(6, current.lockVersion)
            if (statement.executeUpdate() != 1) optimisticConflict("Category", id, current.lockVersion, null)
        }
        connection.category(id)
    }
}

fun ReviewEngine.deleteCategory(id: UUID) = mapSqlConflict {
    database.write { connection ->
        connection.category(id)
        connection.prepareStatement("DELETE FROM category WHERE id = ?").use { statement ->
            statement.setString(1, id.toString())
            statement.executeUpdate()
        }
        Unit
    }
}

fun ReviewEngine.listTemplateVersions(categoryId: UUID): List<TemplateSnapshot> = database.read { connection ->
    connection.category(categoryId)
    connection.prepareStatement(
        "SELECT * FROM template_version WHERE category_id = ? ORDER BY version DESC",
    ).use { statement ->
        statement.setString(1, categoryId.toString())
        statement.executeQuery().use { result ->
            buildList {
                while (result.next()) {
                    val version = result.toTemplateVersion()
                    add(TemplateSnapshot(version, connection.templateCriteria(version.id)))
                }
            }
        }
    }
}

fun ReviewEngine.getTemplateVersion(id: UUID): TemplateSnapshot = database.read { connection ->
    TemplateSnapshot(connection.templateVersion(id), connection.templateCriteria(id))
}

fun ReviewEngine.createTemplateDraft(
    categoryId: UUID,
    criteria: List<CriterionInput>?,
): TemplateSnapshot = mapSqlConflict {
    database.write { connection ->
        val category = connection.category(categoryId)
        if (category.archivedAt != null) conflict("Archived categories cannot receive template versions", "categoryId" to categoryId)

        val versionNumber = connection.prepareStatement(
            "SELECT COALESCE(MAX(version), 0) + 1 FROM template_version WHERE category_id = ?",
        ).use { statement ->
            statement.setString(1, categoryId.toString())
            statement.executeQuery().use { result -> result.next(); result.getInt(1) }
        }
        val id = newId()
        val now = now()
        connection.prepareStatement(
            """
            INSERT INTO template_version(id, category_id, version, status, published_at, created_at, updated_at, lock_version)
            VALUES (?, ?, ?, 'draft', NULL, ?, ?, 0)
            """.trimIndent(),
        ).use { statement ->
            statement.setString(1, id.toString())
            statement.setString(2, categoryId.toString())
            statement.setInt(3, versionNumber)
            statement.setString(4, now.toDatabaseTimestamp())
            statement.setString(5, now.toDatabaseTimestamp())
            statement.executeUpdate()
        }

        val initialCriteria = criteria ?: category.activeTemplateVersionId?.let { activeId ->
            connection.templateCriteria(activeId).map { criterion ->
                CriterionInput(
                    criterionId = criterion.criterionId,
                    name = criterion.name,
                    description = criterion.description,
                    minValue = criterion.scale.minValueString(),
                    maxValue = criterion.scale.maxValueString(),
                    stepValue = criterion.scale.stepValueString(),
                    position = criterion.position,
                    required = criterion.required,
                )
            }
        }.orEmpty()
        replaceTemplateCriteria(connection, id, categoryId, initialCriteria)
        TemplateSnapshot(connection.templateVersion(id), connection.templateCriteria(id))
    }
}

fun ReviewEngine.updateTemplateDraft(
    id: UUID,
    criteria: List<CriterionInput>,
    expectedLockVersion: Long,
): TemplateSnapshot = mapSqlConflict {
    database.write { connection ->
        val version = connection.templateVersion(id)
        if (version.status != TemplateStatus.DRAFT) {
            throw DomainException(DomainErrorCode.IMMUTABLE_RESOURCE, "Published or retired templates cannot be edited")
        }
        if (version.lockVersion != expectedLockVersion) {
            optimisticConflict("Template version", id, expectedLockVersion, version.lockVersion)
        }
        replaceTemplateCriteria(connection, id, version.categoryId, criteria)
        connection.prepareStatement(
            "UPDATE template_version SET updated_at = ?, lock_version = lock_version + 1 WHERE id = ? AND lock_version = ?",
        ).use { statement ->
            statement.setString(1, now().toDatabaseTimestamp())
            statement.setString(2, id.toString())
            statement.setLong(3, version.lockVersion)
            if (statement.executeUpdate() != 1) optimisticConflict("Template version", id, version.lockVersion, null)
        }
        TemplateSnapshot(connection.templateVersion(id), connection.templateCriteria(id))
    }
}

fun ReviewEngine.publishTemplate(id: UUID, expectedLockVersion: Long): TemplateSnapshot = mapSqlConflict {
    database.write { connection ->
        val version = connection.templateVersion(id)
        if (version.status != TemplateStatus.DRAFT) {
            throw DomainException(DomainErrorCode.IMMUTABLE_RESOURCE, "Only a draft template can be published")
        }
        if (version.lockVersion != expectedLockVersion) {
            optimisticConflict("Template version", id, expectedLockVersion, version.lockVersion)
        }
        val criteria = connection.templateCriteria(id)
        if (criteria.isEmpty()) {
            throw DomainException(DomainErrorCode.INVALID_ARGUMENT, "A template must contain at least one criterion")
        }
        val category = connection.category(version.categoryId)
        if (category.archivedAt != null) conflict("Archived categories cannot publish templates", "categoryId" to category.id)
        val publishedAt = now()
        category.activeTemplateVersionId?.takeIf { it != id }?.let { previousId ->
            connection.prepareStatement(
                "UPDATE template_version SET status = 'retired', updated_at = ?, lock_version = lock_version + 1 WHERE id = ? AND status = 'published'",
            ).use { statement ->
                statement.setString(1, publishedAt.toDatabaseTimestamp())
                statement.setString(2, previousId.toString())
                statement.executeUpdate()
            }
        }
        connection.prepareStatement(
            """
            UPDATE template_version
            SET status = 'published', published_at = ?, updated_at = ?, lock_version = lock_version + 1
            WHERE id = ? AND status = 'draft' AND lock_version = ?
            """.trimIndent(),
        ).use { statement ->
            statement.setString(1, publishedAt.toDatabaseTimestamp())
            statement.setString(2, publishedAt.toDatabaseTimestamp())
            statement.setString(3, id.toString())
            statement.setLong(4, version.lockVersion)
            if (statement.executeUpdate() != 1) optimisticConflict("Template version", id, version.lockVersion, null)
        }
        connection.prepareStatement(
            "UPDATE category SET active_template_version_id = ?, updated_at = ?, lock_version = lock_version + 1 WHERE id = ?",
        ).use { statement ->
            statement.setString(1, id.toString())
            statement.setString(2, publishedAt.toDatabaseTimestamp())
            statement.setString(3, version.categoryId.toString())
            statement.executeUpdate()
        }
        TemplateSnapshot(connection.templateVersion(id), connection.templateCriteria(id))
    }
}

private fun validateCriterionInputs(criteria: List<CriterionInput>) {
    val duplicateId = criteria.mapNotNull { it.criterionId }.groupingBy { it }.eachCount().entries.firstOrNull { it.value > 1 }
    if (duplicateId != null) {
        throw DomainException(DomainErrorCode.DUPLICATE_CRITERION, "A criterion can only occur once", mapOf("criterionId" to duplicateId.key.toString()))
    }
    val duplicatePosition = criteria.groupingBy { it.position }.eachCount().entries.firstOrNull { it.value > 1 }
    if (duplicatePosition != null || criteria.any { it.position < 0 }) {
        throw DomainException(DomainErrorCode.INVALID_ARGUMENT, "Criterion positions must be unique and non-negative")
    }
    criteria.forEach {
        requireNonBlank(it.name, "criterion.name")
        it.scale()
    }
}

private fun ReviewEngine.replaceTemplateCriteria(
    connection: Connection,
    templateVersionId: UUID,
    categoryId: UUID,
    criteria: List<CriterionInput>,
) {
    validateCriterionInputs(criteria)
    connection.prepareStatement("DELETE FROM template_criterion WHERE template_version_id = ?").use { statement ->
        statement.setString(1, templateVersionId.toString())
        statement.executeUpdate()
    }
    criteria.forEach { input ->
        val criterionId = input.criterionId ?: newId()
        val existingCategory = connection.prepareStatement("SELECT category_id FROM criterion WHERE id = ?").use { statement ->
            statement.setString(1, criterionId.toString())
            statement.executeQuery().use { result -> if (result.next()) UUID.fromString(result.getString(1)) else null }
        }
        if (existingCategory != null && existingCategory != categoryId) {
            conflict("Criterion IDs cannot cross category boundaries", "criterionId" to criterionId)
        }
        if (existingCategory == null) {
            connection.prepareStatement("INSERT INTO criterion(id, category_id, created_at) VALUES (?, ?, ?)").use { statement ->
                statement.setString(1, criterionId.toString())
                statement.setString(2, categoryId.toString())
                statement.setString(3, now().toDatabaseTimestamp())
                statement.executeUpdate()
            }
        }
        val scale = input.scale()
        connection.prepareStatement(
            """
            INSERT INTO template_criterion(
                template_version_id, criterion_id, name, description,
                min_value, max_value, step_value, position, required
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """.trimIndent(),
        ).use { statement ->
            statement.setString(1, templateVersionId.toString())
            statement.setString(2, criterionId.toString())
            statement.setString(3, requireNonBlank(input.name, "criterion.name"))
            statement.setNullableString(4, input.description?.trim()?.takeIf(String::isNotEmpty))
            statement.setString(5, scale.minValueString())
            statement.setString(6, scale.maxValueString())
            statement.setString(7, scale.stepValueString())
            statement.setInt(8, input.position)
            statement.setInt(9, if (input.required) 1 else 0)
            statement.executeUpdate()
        }
    }
}

internal fun optimisticConflict(resource: String, id: UUID, expected: Long, actual: Long?): Nothing = throw DomainException(
    DomainErrorCode.OPTIMISTIC_LOCK_CONFLICT,
    "$resource changed since it was read",
    buildMap {
        put("id", id.toString())
        put("expectedLockVersion", expected.toString())
        actual?.let { put("actualLockVersion", it.toString()) }
    },
)
