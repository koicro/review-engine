package dev.reviewengine.application

import dev.reviewengine.persistence.Database
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals

class RelationTraversalLimitTest {
    @Test
    fun `a high degree node cannot exceed the traversal result cap`() {
        Database("jdbc:sqlite::memory:").use { database ->
            database.migrate()
            val categoryId = UUID.randomUUID()
            val rootId = UUID.randomUUID()
            val relationTypeId = UUID.randomUUID()
            database.write { connection ->
                connection.prepareStatement(
                    """
                    INSERT INTO category(id, name, created_at, updated_at, lock_version)
                    VALUES (?, 'Category', ?, ?, 0)
                    """.trimIndent(),
                ).use { statement ->
                    statement.setString(1, categoryId.toString())
                    statement.setString(2, TIMESTAMP)
                    statement.setString(3, TIMESTAMP)
                    statement.executeUpdate()
                }
                connection.prepareStatement(
                    """
                    INSERT INTO relation_type(id, key, forward_label, inverse_label, hierarchical, created_at)
                    VALUES (?, 'related', 'related to', 'related from', 0, ?)
                    """.trimIndent(),
                ).use { statement ->
                    statement.setString(1, relationTypeId.toString())
                    statement.setString(2, TIMESTAMP)
                    statement.executeUpdate()
                }
                connection.prepareStatement(
                    """
                    INSERT INTO entity(id, category_id, name, created_at, updated_at, lock_version)
                    VALUES (?, ?, ?, ?, ?, 0)
                    """.trimIndent(),
                ).use { entityStatement ->
                    connection.prepareStatement(
                        """
                        INSERT INTO entity_relation(id, source_entity_id, target_entity_id, relation_type_id, created_at)
                        VALUES (?, ?, ?, ?, ?)
                        """.trimIndent(),
                    ).use { relationStatement ->
                        insertEntity(entityStatement, rootId, categoryId, "Root")
                        repeat(550) { index ->
                            val targetId = UUID.randomUUID()
                            insertEntity(entityStatement, targetId, categoryId, "Target $index")
                            relationStatement.setString(1, UUID.randomUUID().toString())
                            relationStatement.setString(2, rootId.toString())
                            relationStatement.setString(3, targetId.toString())
                            relationStatement.setString(4, relationTypeId.toString())
                            relationStatement.setString(5, TIMESTAMP)
                            relationStatement.addBatch()
                        }
                        entityStatement.executeBatch()
                        relationStatement.executeBatch()
                    }
                }
            }

            val results = ReviewEngine(database).relatedEntities(rootId, maxDepth = 1)

            assertEquals(500, results.size)
        }
    }

    private fun insertEntity(
        statement: java.sql.PreparedStatement,
        id: UUID,
        categoryId: UUID,
        name: String,
    ) {
        statement.setString(1, id.toString())
        statement.setString(2, categoryId.toString())
        statement.setString(3, name)
        statement.setString(4, TIMESTAMP)
        statement.setString(5, TIMESTAMP)
        statement.addBatch()
    }

    private companion object {
        const val TIMESTAMP = "2026-08-13T00:00:00.000000000Z"
    }
}
