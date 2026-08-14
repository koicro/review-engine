package dev.reviewengine.persistence

import java.sql.SQLException
import java.sql.DriverManager
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class DatabaseTest {
    @Test
    fun `migration is idempotent and bootstraps the default reviewer`() {
        Database("jdbc:sqlite::memory:").use { database ->
            database.migrate()
            database.migrate()

            database.read { connection ->
                val tables = connection.prepareStatement(
                    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
                ).use { statement ->
                    statement.executeQuery().use { result ->
                        buildSet { while (result.next()) add(result.getString("name")) }
                    }
                }
                assertTrue("category" in tables)
                assertTrue("template_version" in tables)
                assertTrue("review" in tables)
                assertTrue("access_token" in tables)
                assertTrue("web_session" in tables)

                val reviewer = ReviewerRepository().default(connection)
                assertEquals(DefaultReviewer.ID, reviewer.id)
            }
        }
    }

    @Test
    fun `write rolls back the complete transaction on failure`() {
        Database("jdbc:sqlite::memory:").use { database ->
            database.migrate()
            assertFailsWith<ExpectedFailure> {
                database.write { connection ->
                    connection.prepareStatement(
                        """INSERT INTO category
                            (id, name, description, active_template_version_id, archived_at, created_at, updated_at, lock_version)
                            VALUES ('00000000-0000-0000-0000-000000000099', 'Temporary', NULL, NULL, NULL,
                                    '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z', 0)""",
                    ).use { it.executeUpdate() }
                    throw ExpectedFailure()
                }
            }

            val exists = database.read { connection ->
                connection.prepareStatement("SELECT 1 FROM category WHERE name = 'Temporary'").use { statement ->
                    statement.executeQuery().use { it.next() }
                }
            }
            assertFalse(exists)
        }
    }

    @Test
    fun `every connection enforces foreign keys`() {
        Database("jdbc:sqlite::memory:").use { database ->
            database.migrate()
            assertFailsWith<SQLException> {
                database.write { connection ->
                    connection.prepareStatement(
                        """INSERT INTO entity
                            (id, category_id, name, description, archived_at, created_at, updated_at, lock_version)
                            VALUES ('00000000-0000-0000-0000-000000000098',
                                    '00000000-0000-0000-0000-000000000097', 'Orphan', NULL, NULL,
                                    '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z', 0)""",
                    ).use { it.executeUpdate() }
                }
            }
        }
    }

    @Test
    fun `read callback observes one snapshot across all statements`() {
        val path = Files.createTempFile("review-engine-snapshot-", ".sqlite")
        val jdbcUrl = "jdbc:sqlite:${path.toAbsolutePath()}"
        try {
            Database(jdbcUrl).use { database ->
                database.migrate()
                DriverManager.getConnection(jdbcUrl).use { connection ->
                    connection.createStatement().use { statement ->
                        statement.executeQuery("PRAGMA journal_mode = WAL").use { result ->
                            assertTrue(result.next())
                            assertEquals("wal", result.getString(1).lowercase())
                        }
                    }
                }
                database.write { connection ->
                    connection.createStatement().use { statement ->
                        statement.executeUpdate(
                            """
                            INSERT INTO category(id, name, created_at, updated_at)
                            VALUES (
                                '00000000-0000-0000-0000-000000000099',
                                'Before',
                                '2026-08-13T00:00:00.000000000Z',
                                '2026-08-13T00:00:00.000000000Z'
                            )
                            """.trimIndent(),
                        )
                    }
                }

                val firstRead = CountDownLatch(1)
                val writerCommitted = CountDownLatch(1)
                val executor = Executors.newFixedThreadPool(2)
                try {
                    val reader = executor.submit<List<String>> {
                        database.read { connection ->
                            fun currentName(): String = connection.createStatement().use { statement ->
                                statement.executeQuery(
                                    "SELECT name FROM category WHERE id = '00000000-0000-0000-0000-000000000099'",
                                ).use { result ->
                                    assertTrue(result.next())
                                    result.getString(1)
                                }
                            }
                            val before = currentName()
                            firstRead.countDown()
                            assertTrue(writerCommitted.await(10, TimeUnit.SECONDS))
                            listOf(before, currentName())
                        }
                    }
                    val writer = executor.submit {
                        assertTrue(firstRead.await(10, TimeUnit.SECONDS))
                        database.write { connection ->
                            connection.createStatement().use { statement ->
                                statement.executeUpdate(
                                    "UPDATE category SET name = 'After' WHERE id = '00000000-0000-0000-0000-000000000099'",
                                )
                            }
                        }
                        writerCommitted.countDown()
                    }

                    writer.get(10, TimeUnit.SECONDS)
                    assertEquals(listOf("Before", "Before"), reader.get(10, TimeUnit.SECONDS))
                    database.read { connection ->
                        connection.createStatement().use { statement ->
                            statement.executeQuery(
                                "SELECT name FROM category WHERE id = '00000000-0000-0000-0000-000000000099'",
                            ).use { result ->
                                assertTrue(result.next())
                                assertEquals("After", result.getString(1))
                            }
                        }
                    }
                } finally {
                    executor.shutdownNow()
                }
            }
        } finally {
            Files.deleteIfExists(path)
        }
    }

    private class ExpectedFailure : RuntimeException()
}
