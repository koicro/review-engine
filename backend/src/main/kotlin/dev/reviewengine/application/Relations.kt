package dev.reviewengine.application

import dev.reviewengine.domain.DomainErrorCode
import dev.reviewengine.domain.DomainException
import dev.reviewengine.domain.EntityRelation
import dev.reviewengine.domain.RelationType
import dev.reviewengine.persistence.toDatabaseTimestamp
import java.sql.Connection
import java.util.ArrayDeque
import java.util.UUID

fun ReviewEngine.listRelationTypes(): List<RelationType> = database.read { connection ->
    connection.createStatement().use { statement ->
        statement.executeQuery("SELECT * FROM relation_type ORDER BY lower(key), id").use { result ->
            buildList { while (result.next()) add(result.toRelationType()) }
        }
    }
}

fun ReviewEngine.createRelationType(
    key: String,
    forwardLabel: String,
    inverseLabel: String,
    hierarchical: Boolean,
): RelationType = mapSqlConflict {
    database.write { connection ->
        val normalizedKey = requireNonBlank(key, "key").lowercase()
        if (!normalizedKey.matches(Regex("[a-z][a-z0-9_-]{0,63}"))) {
            throw DomainException(
                DomainErrorCode.INVALID_ARGUMENT,
                "Relation type key must use lowercase letters, numbers, underscores, or hyphens",
            )
        }
        val id = newId()
        connection.prepareStatement(
            """
            INSERT INTO relation_type(id, key, forward_label, inverse_label, hierarchical, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """.trimIndent(),
        ).use { statement ->
            statement.setString(1, id.toString())
            statement.setString(2, normalizedKey)
            statement.setString(3, requireNonBlank(forwardLabel, "forwardLabel"))
            statement.setString(4, requireNonBlank(inverseLabel, "inverseLabel"))
            statement.setInt(5, if (hierarchical) 1 else 0)
            statement.setString(6, now().toDatabaseTimestamp())
            statement.executeUpdate()
        }
        connection.relationType(id)
    }
}

fun ReviewEngine.listRelations(
    entityId: UUID? = null,
    relationTypeId: UUID? = null,
    cursor: String? = null,
    limit: Int? = null,
): Page<RelationSnapshot> = database.read { connection ->
    entityId?.let(connection::entity)
    relationTypeId?.let(connection::relationType)
    val offset = decodeCursor(cursor)
    val pageSize = normalizeLimit(limit)
    connection.prepareStatement(
        """
        SELECT * FROM entity_relation
        WHERE (? IS NULL OR source_entity_id = ? OR target_entity_id = ?)
          AND (? IS NULL OR relation_type_id = ?)
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?
        """.trimIndent(),
    ).use { statement ->
        statement.setNullableString(1, entityId?.toString())
        statement.setNullableString(2, entityId?.toString())
        statement.setNullableString(3, entityId?.toString())
        statement.setNullableString(4, relationTypeId?.toString())
        statement.setNullableString(5, relationTypeId?.toString())
        statement.setInt(6, pageSize + 1)
        statement.setInt(7, offset)
        statement.executeQuery().use { result ->
            val relations = buildList { while (result.next()) add(result.toEntityRelation()) }
            Page(
                items = relations.take(pageSize).map { relation -> relationSnapshot(connection, relation) },
                nextCursor = if (relations.size > pageSize) encodeCursor(offset + pageSize) else null,
            )
        }
    }
}

fun ReviewEngine.createRelation(sourceId: UUID, targetId: UUID, typeId: UUID): RelationSnapshot = mapSqlConflict {
    database.write { connection ->
        val source = connection.entity(sourceId)
        val target = connection.entity(targetId)
        if (source.archivedAt != null || target.archivedAt != null) {
            conflict("Archived entities cannot receive new relations")
        }
        val type = connection.relationType(typeId)
        if (sourceId == targetId && type.hierarchical) {
            throw DomainException(DomainErrorCode.HIERARCHY_CYCLE, "A hierarchical relation cannot point to itself")
        }
        if (type.hierarchical && isReachable(connection, typeId, targetId, sourceId)) {
            throw DomainException(
                DomainErrorCode.HIERARCHY_CYCLE,
                "The relation would create a hierarchy cycle",
                mapOf("relationTypeId" to typeId.toString()),
            )
        }
        val relation = EntityRelation(newId(), sourceId, targetId, typeId, now())
        connection.prepareStatement(
            """
            INSERT INTO entity_relation(id, source_entity_id, target_entity_id, relation_type_id, created_at)
            VALUES (?, ?, ?, ?, ?)
            """.trimIndent(),
        ).use { statement ->
            statement.setString(1, relation.id.toString())
            statement.setString(2, sourceId.toString())
            statement.setString(3, targetId.toString())
            statement.setString(4, typeId.toString())
            statement.setString(5, relation.createdAt.toDatabaseTimestamp())
            statement.executeUpdate()
        }
        relationSnapshot(connection, relation)
    }
}

fun ReviewEngine.deleteRelation(id: UUID) = mapSqlConflict {
    database.write { connection ->
        connection.prepareStatement("DELETE FROM entity_relation WHERE id = ?").use { statement ->
            statement.setString(1, id.toString())
            if (statement.executeUpdate() != 1) notFound("Relation", id)
        }
        Unit
    }
}

fun ReviewEngine.relatedEntities(
    entityId: UUID,
    relationTypeId: UUID? = null,
    direction: RelationDirection = RelationDirection.BOTH,
    maxDepth: Int = 1,
): List<RelatedEntitySnapshot> = database.read { connection ->
    connection.entity(entityId)
    relationTypeId?.let(connection::relationType)
    if (maxDepth !in 1..5) {
        throw DomainException(DomainErrorCode.INVALID_ARGUMENT, "maxDepth must be between 1 and 5")
    }
    data class Node(val id: UUID, val depth: Int, val path: List<UUID>)
    val queue = ArrayDeque<Node>()
    queue.add(Node(entityId, 0, listOf(entityId)))
    val visited = mutableSetOf(entityId)
    val found = mutableListOf<RelatedEntitySnapshot>()
    while (queue.isNotEmpty() && found.size < 500) {
        val node = queue.removeFirst()
        if (node.depth >= maxDepth) continue
        val remaining = 500 - found.size
        for ((relation, edgeDirection) in adjacent(connection, node.id, relationTypeId, direction, remaining)) {
            if (found.size >= 500) break
            val nextId = if (edgeDirection == RelationDirection.OUTGOING) relation.targetEntityId else relation.sourceEntityId
            if (nextId !in visited) {
                visited += nextId
                val path = node.path + nextId
                val type = connection.relationType(relation.relationTypeId)
                found += RelatedEntitySnapshot(connection.entity(nextId), relation, type, edgeDirection, node.depth + 1, path)
                queue.add(Node(nextId, node.depth + 1, path))
            }
        }
    }
    found
}

private fun relationSnapshot(connection: Connection, relation: EntityRelation) = RelationSnapshot(
    relation,
    connection.entity(relation.sourceEntityId),
    connection.entity(relation.targetEntityId),
    connection.relationType(relation.relationTypeId),
)

private fun adjacent(
    connection: Connection,
    entityId: UUID,
    relationTypeId: UUID?,
    direction: RelationDirection,
    limit: Int,
): List<Pair<EntityRelation, RelationDirection>> {
    val outgoing = direction != RelationDirection.INCOMING
    val incoming = direction != RelationDirection.OUTGOING
    return connection.prepareStatement(
        """
        SELECT * FROM entity_relation
        WHERE (? = 1 AND source_entity_id = ? OR ? = 1 AND target_entity_id = ?)
          AND (? IS NULL OR relation_type_id = ?)
        ORDER BY created_at, id
        LIMIT ?
        """.trimIndent(),
    ).use { statement ->
        statement.setInt(1, if (outgoing) 1 else 0)
        statement.setString(2, entityId.toString())
        statement.setInt(3, if (incoming) 1 else 0)
        statement.setString(4, entityId.toString())
        statement.setNullableString(5, relationTypeId?.toString())
        statement.setNullableString(6, relationTypeId?.toString())
        statement.setInt(7, limit.coerceIn(1, 500))
        statement.executeQuery().use { result ->
            buildList {
                while (result.next()) {
                    val relation = result.toEntityRelation()
                    val edgeDirection = if (relation.sourceEntityId == entityId) RelationDirection.OUTGOING else RelationDirection.INCOMING
                    add(relation to edgeDirection)
                }
            }
        }
    }
}

private fun isReachable(connection: Connection, typeId: UUID, start: UUID, target: UUID): Boolean {
    val queue = ArrayDeque<UUID>()
    val visited = mutableSetOf(start)
    queue.add(start)
    while (queue.isNotEmpty()) {
        val current = queue.removeFirst()
        if (current == target) return true
        connection.prepareStatement(
            "SELECT target_entity_id FROM entity_relation WHERE source_entity_id = ? AND relation_type_id = ?",
        ).use { statement ->
            statement.setString(1, current.toString())
            statement.setString(2, typeId.toString())
            statement.executeQuery().use { result ->
                while (result.next()) {
                    val next = UUID.fromString(result.getString(1))
                    if (visited.add(next)) queue.add(next)
                }
            }
        }
    }
    return false
}
