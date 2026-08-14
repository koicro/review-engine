package dev.reviewengine.persistence

import dev.reviewengine.domain.DomainRules
import dev.reviewengine.domain.Entity
import java.sql.Connection
import java.sql.ResultSet
import java.util.UUID

class EntityRepository {
    fun insert(connection: Connection, entity: Entity) {
        connection.prepareStatement(
            """INSERT INTO entity
                (id, category_id, name, description, archived_at, created_at, updated_at, lock_version)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        ).use { statement ->
            statement.setUuid(1, entity.id)
            statement.setUuid(2, entity.categoryId)
            statement.setString(3, entity.name)
            statement.setString(4, entity.description)
            statement.setNullableInstant(5, entity.archivedAt)
            statement.setInstant(6, entity.createdAt)
            statement.setInstant(7, entity.updatedAt)
            statement.setLong(8, entity.lockVersion)
            statement.executeUpdate()
        }
    }

    fun findById(connection: Connection, id: UUID): Entity? = connection.prepareStatement(
        "SELECT * FROM entity WHERE id = ?",
    ).use { statement ->
        statement.setUuid(1, id)
        statement.executeQuery().use { result -> if (result.next()) result.toEntity() else null }
    }

    fun getById(connection: Connection, id: UUID): Entity = findById(connection, id) ?: notFound("Entity", id)

    fun list(
        connection: Connection,
        categoryId: UUID? = null,
        includeArchived: Boolean = false,
    ): List<Entity> {
        val conditions = mutableListOf<String>()
        if (categoryId != null) conditions += "category_id = ?"
        if (!includeArchived) conditions += "archived_at IS NULL"
        val sql = buildString {
            append("SELECT * FROM entity")
            if (conditions.isNotEmpty()) append(" WHERE ${conditions.joinToString(" AND ")}")
            append(" ORDER BY name, id")
        }
        return connection.prepareStatement(sql).use { statement ->
            if (categoryId != null) statement.setUuid(1, categoryId)
            statement.executeQuery().use { result -> result.mapRows { it.toEntity() } }
        }
    }

    /** Uses [Entity.lockVersion] as the expected version and returns the incremented value. */
    fun update(connection: Connection, entity: Entity): Entity {
        val current = getById(connection, entity.id)
        if (current.categoryId != entity.categoryId) {
            DomainRules.requireEntityCategoryChangeAllowed(hasFinalReview(connection, entity.id))
        }
        val changed = connection.prepareStatement(
            """UPDATE entity SET category_id = ?, name = ?, description = ?, archived_at = ?, updated_at = ?,
                lock_version = lock_version + 1 WHERE id = ? AND lock_version = ?""",
        ).use { statement ->
            statement.setUuid(1, entity.categoryId)
            statement.setString(2, entity.name)
            statement.setString(3, entity.description)
            statement.setNullableInstant(4, entity.archivedAt)
            statement.setInstant(5, entity.updatedAt)
            statement.setUuid(6, entity.id)
            statement.setLong(7, entity.lockVersion)
            statement.executeUpdate()
        }
        if (changed != 1) optimisticLockFailure("Entity", entity.id, entity.lockVersion)
        return entity.copy(lockVersion = entity.lockVersion + 1)
    }

    fun hasFinalReview(connection: Connection, entityId: UUID): Boolean = connection.prepareStatement(
        "SELECT 1 FROM review WHERE entity_id = ? AND status IN ('final', 'superseded') LIMIT 1",
    ).use { statement ->
        statement.setUuid(1, entityId)
        statement.executeQuery().use { it.next() }
    }

    fun delete(connection: Connection, id: UUID): Boolean = connection.prepareStatement(
        "DELETE FROM entity WHERE id = ?",
    ).use { statement ->
        statement.setUuid(1, id)
        statement.executeUpdate() == 1
    }

    private fun ResultSet.toEntity() = Entity(
        id = uuid("id"),
        categoryId = uuid("category_id"),
        name = getString("name"),
        description = getString("description"),
        archivedAt = nullableInstant("archived_at"),
        createdAt = instant("created_at"),
        updatedAt = instant("updated_at"),
        lockVersion = getLong("lock_version"),
    )
}
