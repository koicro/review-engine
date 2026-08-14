package dev.reviewengine.persistence

import dev.reviewengine.domain.Category
import java.sql.Connection
import java.sql.ResultSet
import java.util.UUID

class CategoryRepository {
    fun insert(connection: Connection, category: Category) {
        connection.prepareStatement(
            """INSERT INTO category
                (id, name, description, active_template_version_id, archived_at, created_at, updated_at, lock_version)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        ).use { statement ->
            statement.setUuid(1, category.id)
            statement.setString(2, category.name)
            statement.setString(3, category.description)
            statement.setNullableUuid(4, category.activeTemplateVersionId)
            statement.setNullableInstant(5, category.archivedAt)
            statement.setInstant(6, category.createdAt)
            statement.setInstant(7, category.updatedAt)
            statement.setLong(8, category.lockVersion)
            statement.executeUpdate()
        }
    }

    fun findById(connection: Connection, id: UUID): Category? = connection.prepareStatement(
        "SELECT * FROM category WHERE id = ?",
    ).use { statement ->
        statement.setUuid(1, id)
        statement.executeQuery().use { result -> if (result.next()) result.toCategory() else null }
    }

    fun getById(connection: Connection, id: UUID): Category = findById(connection, id) ?: notFound("Category", id)

    fun list(connection: Connection, includeArchived: Boolean = false): List<Category> {
        val sql = buildString {
            append("SELECT * FROM category")
            if (!includeArchived) append(" WHERE archived_at IS NULL")
            append(" ORDER BY name, id")
        }
        return connection.prepareStatement(sql).use { statement ->
            statement.executeQuery().use { result -> result.mapRows { it.toCategory() } }
        }
    }

    /** Uses [Category.lockVersion] as the expected version and returns the incremented value. */
    fun update(connection: Connection, category: Category): Category {
        val updated = connection.prepareStatement(
            """UPDATE category SET name = ?, description = ?, active_template_version_id = ?, archived_at = ?,
                updated_at = ?, lock_version = lock_version + 1 WHERE id = ? AND lock_version = ?""",
        ).use { statement ->
            statement.setString(1, category.name)
            statement.setString(2, category.description)
            statement.setNullableUuid(3, category.activeTemplateVersionId)
            statement.setNullableInstant(4, category.archivedAt)
            statement.setInstant(5, category.updatedAt)
            statement.setUuid(6, category.id)
            statement.setLong(7, category.lockVersion)
            statement.executeUpdate()
        }
        if (updated != 1) optimisticLockFailure("Category", category.id, category.lockVersion)
        return category.copy(lockVersion = category.lockVersion + 1)
    }

    fun delete(connection: Connection, id: UUID): Boolean = connection.prepareStatement(
        "DELETE FROM category WHERE id = ?",
    ).use { statement ->
        statement.setUuid(1, id)
        statement.executeUpdate() == 1
    }

    private fun ResultSet.toCategory() = Category(
        id = uuid("id"),
        name = getString("name"),
        description = getString("description"),
        activeTemplateVersionId = nullableUuid("active_template_version_id"),
        archivedAt = nullableInstant("archived_at"),
        createdAt = instant("created_at"),
        updatedAt = instant("updated_at"),
        lockVersion = getLong("lock_version"),
    )
}
