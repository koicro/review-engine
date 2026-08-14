package dev.reviewengine.persistence

import dev.reviewengine.domain.Reviewer
import java.sql.Connection
import java.sql.ResultSet
import java.util.UUID

object DefaultReviewer {
    val ID: UUID = UUID.fromString("00000000-0000-0000-0000-000000000001")
}

class ReviewerRepository {
    fun insert(connection: Connection, reviewer: Reviewer) {
        connection.prepareStatement(
            "INSERT INTO reviewer(id, display_name, archived_at, created_at) VALUES (?, ?, ?, ?)",
        ).use { statement ->
            statement.setUuid(1, reviewer.id)
            statement.setString(2, reviewer.displayName)
            statement.setNullableInstant(3, reviewer.archivedAt)
            statement.setInstant(4, reviewer.createdAt)
            statement.executeUpdate()
        }
    }

    fun findById(connection: Connection, id: UUID): Reviewer? = connection.prepareStatement(
        "SELECT * FROM reviewer WHERE id = ?",
    ).use { statement ->
        statement.setUuid(1, id)
        statement.executeQuery().use { result -> if (result.next()) result.toReviewer() else null }
    }

    fun getById(connection: Connection, id: UUID): Reviewer = findById(connection, id) ?: notFound("Reviewer", id)

    fun default(connection: Connection): Reviewer = getById(connection, DefaultReviewer.ID)

    fun list(connection: Connection, includeArchived: Boolean = false): List<Reviewer> {
        val sql = "SELECT * FROM reviewer" +
            (if (includeArchived) "" else " WHERE archived_at IS NULL") +
            " ORDER BY display_name, id"
        return connection.prepareStatement(sql).use { statement ->
            statement.executeQuery().use { result -> result.mapRows { it.toReviewer() } }
        }
    }

    private fun ResultSet.toReviewer() = Reviewer(
        id = uuid("id"),
        displayName = getString("display_name"),
        archivedAt = nullableInstant("archived_at"),
        createdAt = instant("created_at"),
    )
}
