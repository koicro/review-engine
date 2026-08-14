package dev.reviewengine.persistence

import dev.reviewengine.domain.DomainErrorCode
import dev.reviewengine.domain.DomainException
import dev.reviewengine.domain.EntityRelation
import dev.reviewengine.domain.RelatedEntity
import dev.reviewengine.domain.RelationDirection
import dev.reviewengine.domain.RelationType
import java.sql.Connection
import java.sql.ResultSet
import java.util.UUID

class RelationRepository(
    private val maximumTraversalDepth: Int = 10,
) {
    init {
        require(maximumTraversalDepth > 0) { "maximumTraversalDepth must be positive" }
    }

    fun insertType(connection: Connection, type: RelationType) {
        connection.prepareStatement(
            """INSERT INTO relation_type(id, key, forward_label, inverse_label, hierarchical, created_at)
                VALUES (?, ?, ?, ?, ?, ?)""",
        ).use { statement ->
            statement.setUuid(1, type.id)
            statement.setString(2, type.key)
            statement.setString(3, type.forwardLabel)
            statement.setString(4, type.inverseLabel)
            statement.setInt(5, if (type.hierarchical) 1 else 0)
            statement.setInstant(6, type.createdAt)
            statement.executeUpdate()
        }
    }

    fun findTypeById(connection: Connection, id: UUID): RelationType? = connection.prepareStatement(
        "SELECT * FROM relation_type WHERE id = ?",
    ).use { statement ->
        statement.setUuid(1, id)
        statement.executeQuery().use { result -> if (result.next()) result.toRelationType() else null }
    }

    fun findTypeByKey(connection: Connection, key: String): RelationType? = connection.prepareStatement(
        "SELECT * FROM relation_type WHERE key = ?",
    ).use { statement ->
        statement.setString(1, key)
        statement.executeQuery().use { result -> if (result.next()) result.toRelationType() else null }
    }

    fun listTypes(connection: Connection): List<RelationType> = connection.prepareStatement(
        "SELECT * FROM relation_type ORDER BY key",
    ).use { statement -> statement.executeQuery().use { result -> result.mapRows { it.toRelationType() } } }

    fun insertRelation(connection: Connection, relation: EntityRelation) {
        val type = findTypeById(connection, relation.relationTypeId)
            ?: notFound("Relation type", relation.relationTypeId)
        if (exists(connection, relation.sourceEntityId, relation.targetEntityId, relation.relationTypeId)) {
            throw DomainException(
                DomainErrorCode.CONFLICT,
                "The same entity relation already exists",
                mapOf("relationTypeId" to relation.relationTypeId.toString()),
            )
        }
        if (type.hierarchical && wouldCreateHierarchyCycle(connection, relation)) {
            throw DomainException(
                DomainErrorCode.HIERARCHY_CYCLE,
                "A hierarchical relation cannot create a cycle",
                mapOf(
                    "sourceEntityId" to relation.sourceEntityId.toString(),
                    "targetEntityId" to relation.targetEntityId.toString(),
                    "relationTypeId" to relation.relationTypeId.toString(),
                ),
            )
        }
        connection.prepareStatement(
            """INSERT INTO entity_relation(id, source_entity_id, target_entity_id, relation_type_id, created_at)
                VALUES (?, ?, ?, ?, ?)""",
        ).use { statement ->
            statement.setUuid(1, relation.id)
            statement.setUuid(2, relation.sourceEntityId)
            statement.setUuid(3, relation.targetEntityId)
            statement.setUuid(4, relation.relationTypeId)
            statement.setInstant(5, relation.createdAt)
            statement.executeUpdate()
        }
    }

    fun findRelationById(connection: Connection, id: UUID): EntityRelation? = connection.prepareStatement(
        "SELECT * FROM entity_relation WHERE id = ?",
    ).use { statement ->
        statement.setUuid(1, id)
        statement.executeQuery().use { result -> if (result.next()) result.toEntityRelation() else null }
    }

    fun listRelations(
        connection: Connection,
        entityId: UUID,
        direction: RelationDirection = RelationDirection.BOTH,
        relationTypeId: UUID? = null,
    ): List<EntityRelation> {
        val endpoint = when (direction) {
            RelationDirection.OUTGOING -> "source_entity_id = ?"
            RelationDirection.INCOMING -> "target_entity_id = ?"
            RelationDirection.BOTH -> "(source_entity_id = ? OR target_entity_id = ?)"
        }
        val sql = "SELECT * FROM entity_relation WHERE $endpoint" +
            (if (relationTypeId == null) "" else " AND relation_type_id = ?") +
            " ORDER BY created_at, id"
        return connection.prepareStatement(sql).use { statement ->
            var parameter = 1
            statement.setUuid(parameter++, entityId)
            if (direction == RelationDirection.BOTH) statement.setUuid(parameter++, entityId)
            if (relationTypeId != null) statement.setUuid(parameter, relationTypeId)
            statement.executeQuery().use { result -> result.mapRows { it.toEntityRelation() } }
        }
    }

    /** Returns distinct related entity IDs and their shortest depth. */
    fun traverse(
        connection: Connection,
        entityId: UUID,
        direction: RelationDirection,
        maxDepth: Int,
        relationTypeId: UUID? = null,
    ): List<RelatedEntity> {
        if (maxDepth !in 1..maximumTraversalDepth) {
            throw DomainException(
                DomainErrorCode.INVALID_STATE_TRANSITION,
                "Traversal depth is outside the configured limit",
                mapOf("maxDepth" to maxDepth.toString(), "maximumDepth" to maximumTraversalDepth.toString()),
            )
        }
        val nextExpression = when (direction) {
            RelationDirection.OUTGOING -> "er.target_entity_id"
            RelationDirection.INCOMING -> "er.source_entity_id"
            RelationDirection.BOTH -> "CASE WHEN er.source_entity_id = walk.entity_id THEN er.target_entity_id ELSE er.source_entity_id END"
        }
        val joinExpression = when (direction) {
            RelationDirection.OUTGOING -> "er.source_entity_id = walk.entity_id"
            RelationDirection.INCOMING -> "er.target_entity_id = walk.entity_id"
            RelationDirection.BOTH -> "(er.source_entity_id = walk.entity_id OR er.target_entity_id = walk.entity_id)"
        }
        val typeFilter = if (relationTypeId == null) "" else " AND er.relation_type_id = ?"
        val sql = """
            WITH RECURSIVE walk(entity_id, depth, path) AS (
                SELECT ?, 0, '|' || ? || '|'
                UNION ALL
                SELECT $nextExpression, walk.depth + 1, walk.path || $nextExpression || '|'
                FROM entity_relation er JOIN walk ON $joinExpression
                WHERE walk.depth < ?$typeFilter
                  AND instr(walk.path, '|' || $nextExpression || '|') = 0
            )
            SELECT entity_id, MIN(depth) AS depth FROM walk
            WHERE depth > 0 GROUP BY entity_id ORDER BY depth, entity_id
        """.trimIndent()
        return connection.prepareStatement(sql).use { statement ->
            statement.setUuid(1, entityId)
            statement.setUuid(2, entityId)
            statement.setInt(3, maxDepth)
            if (relationTypeId != null) statement.setUuid(4, relationTypeId)
            statement.executeQuery().use { result ->
                result.mapRows { RelatedEntity(UUID.fromString(it.getString("entity_id")), it.getInt("depth")) }
            }
        }
    }

    fun deleteRelation(connection: Connection, id: UUID): Boolean = connection.prepareStatement(
        "DELETE FROM entity_relation WHERE id = ?",
    ).use { statement ->
        statement.setUuid(1, id)
        statement.executeUpdate() == 1
    }

    fun wouldCreateHierarchyCycle(connection: Connection, relation: EntityRelation): Boolean {
        if (relation.sourceEntityId == relation.targetEntityId) return true
        return connection.prepareStatement(
            """
            WITH RECURSIVE reachable(entity_id) AS (
                SELECT ?
                UNION
                SELECT er.target_entity_id
                FROM entity_relation er JOIN reachable ON er.source_entity_id = reachable.entity_id
                WHERE er.relation_type_id = ?
            )
            SELECT 1 FROM reachable WHERE entity_id = ? LIMIT 1
            """.trimIndent(),
        ).use { statement ->
            statement.setUuid(1, relation.targetEntityId)
            statement.setUuid(2, relation.relationTypeId)
            statement.setUuid(3, relation.sourceEntityId)
            statement.executeQuery().use { it.next() }
        }
    }

    private fun exists(connection: Connection, source: UUID, target: UUID, type: UUID): Boolean = connection.prepareStatement(
        """SELECT 1 FROM entity_relation
            WHERE source_entity_id = ? AND target_entity_id = ? AND relation_type_id = ? LIMIT 1""",
    ).use { statement ->
        statement.setUuid(1, source)
        statement.setUuid(2, target)
        statement.setUuid(3, type)
        statement.executeQuery().use { it.next() }
    }

    private fun ResultSet.toRelationType() = RelationType(
        id = uuid("id"),
        key = getString("key"),
        forwardLabel = getString("forward_label"),
        inverseLabel = getString("inverse_label"),
        hierarchical = getInt("hierarchical") == 1,
        createdAt = instant("created_at"),
    )

    private fun ResultSet.toEntityRelation() = EntityRelation(
        id = uuid("id"),
        sourceEntityId = uuid("source_entity_id"),
        targetEntityId = uuid("target_entity_id"),
        relationTypeId = uuid("relation_type_id"),
        createdAt = instant("created_at"),
    )
}
