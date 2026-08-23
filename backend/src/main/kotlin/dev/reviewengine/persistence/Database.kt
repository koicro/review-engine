package dev.reviewengine.persistence

import java.sql.Connection
import java.sql.DriverManager
import java.time.Instant
import java.util.UUID

class PersistenceException(message: String, cause: Throwable? = null) : RuntimeException(message, cause)

/**
 * Small JDBC boundary for SQLite. A callback owns neither the connection nor the transaction.
 */
class Database(jdbcUrl: String) : AutoCloseable {
    private val effectiveJdbcUrl: String
    private val memoryAnchor: Connection?

    init {
        require(jdbcUrl.startsWith("jdbc:sqlite:")) { "Database requires a SQLite JDBC URL" }
        try {
            Class.forName("org.sqlite.JDBC")
        } catch (exception: ClassNotFoundException) {
            throw PersistenceException("SQLite JDBC driver is not available", exception)
        }

        if (jdbcUrl == "jdbc:sqlite::memory:") {
            effectiveJdbcUrl = "jdbc:sqlite:file:review-engine-${UUID.randomUUID()}?mode=memory&cache=shared"
            memoryAnchor = openConnection(effectiveJdbcUrl)
        } else {
            effectiveJdbcUrl = jdbcUrl
            memoryAnchor = null
        }
    }

    fun migrate() {
        write { connection ->
            connection.createStatement().use { statement ->
                statement.executeUpdate(
                    """
                    CREATE TABLE IF NOT EXISTS schema_migration (
                        version INTEGER PRIMARY KEY NOT NULL,
                        description TEXT NOT NULL,
                        applied_at TEXT NOT NULL
                    )
                    """.trimIndent(),
                )
            }

            migrations.forEach { migration ->
                if (!isApplied(connection, migration.version)) {
                    val script = Database::class.java.getResource(migration.resource)?.readText()
                        ?: throw PersistenceException("Missing migration resource ${migration.resource}")
                    splitSqlStatements(script).forEach { sql ->
                        connection.createStatement().use { it.execute(sql) }
                    }
                    connection.prepareStatement(
                        "INSERT INTO schema_migration(version, description, applied_at) VALUES (?, ?, ?)",
                    ).use { statement ->
                        statement.setInt(1, migration.version)
                        statement.setString(2, migration.description)
                        statement.setString(3, Instant.now().toDatabaseTimestamp())
                        statement.executeUpdate()
                    }
                }
            }
        }
    }

    /** Keeps all statements in a callback on one SQLite read snapshot. */
    fun <T> read(block: (Connection) -> T): T = openConnection(effectiveJdbcUrl).use { connection ->
        connection.autoCommit = false
        try {
            val result = block(connection)
            connection.commit()
            result
        } catch (failure: Throwable) {
            try {
                connection.rollback()
            } catch (rollbackFailure: Throwable) {
                failure.addSuppressed(rollbackFailure)
            }
            throw failure
        } finally {
            connection.autoCommit = true
        }
    }

    fun <T> write(block: (Connection) -> T): T = openConnection(effectiveJdbcUrl).use { connection ->
        connection.autoCommit = false
        try {
            val result = block(connection)
            connection.commit()
            result
        } catch (failure: Throwable) {
            try {
                connection.rollback()
            } catch (rollbackFailure: Throwable) {
                failure.addSuppressed(rollbackFailure)
            }
            throw failure
        } finally {
            connection.autoCommit = true
        }
    }

    override fun close() {
        memoryAnchor?.close()
    }

    private fun openConnection(url: String): Connection = DriverManager.getConnection(url).also(::configure)

    private fun configure(connection: Connection) {
        connection.createStatement().use { statement ->
            statement.execute("PRAGMA foreign_keys = ON")
            statement.execute("PRAGMA busy_timeout = 5000")
        }
    }

    private fun isApplied(connection: Connection, version: Int): Boolean = connection.prepareStatement(
        "SELECT 1 FROM schema_migration WHERE version = ?",
    ).use { statement ->
        statement.setInt(1, version)
        statement.executeQuery().use { it.next() }
    }

    private data class Migration(val version: Int, val description: String, val resource: String)

    private companion object {
        val migrations = listOf(
            Migration(1, "initial schema", "/db/migration/V001__initial_schema.sql"),
            Migration(2, "review visibility", "/db/migration/V002__review_visibility.sql"),
        )

        /** Splits ordinary migration SQL while respecting quoted strings and SQL comments. */
        fun splitSqlStatements(script: String): List<String> {
            val statements = mutableListOf<String>()
            val current = StringBuilder()
            var singleQuoted = false
            var doubleQuoted = false
            var lineComment = false
            var blockComment = false
            var index = 0

            while (index < script.length) {
                val char = script[index]
                val next = script.getOrNull(index + 1)
                when {
                    lineComment -> {
                        if (char == '\n') {
                            lineComment = false
                            current.append(char)
                        }
                    }
                    blockComment -> {
                        if (char == '*' && next == '/') {
                            blockComment = false
                            index++
                        }
                    }
                    !singleQuoted && !doubleQuoted && char == '-' && next == '-' -> {
                        lineComment = true
                        index++
                    }
                    !singleQuoted && !doubleQuoted && char == '/' && next == '*' -> {
                        blockComment = true
                        index++
                    }
                    char == '\'' && !doubleQuoted -> {
                        current.append(char)
                        if (singleQuoted && next == '\'') {
                            current.append(next)
                            index++
                        } else {
                            singleQuoted = !singleQuoted
                        }
                    }
                    char == '"' && !singleQuoted -> {
                        current.append(char)
                        doubleQuoted = !doubleQuoted
                    }
                    char == ';' && !singleQuoted && !doubleQuoted -> {
                        current.toString().trim().takeIf(String::isNotEmpty)?.let(statements::add)
                        current.clear()
                    }
                    else -> current.append(char)
                }
                index++
            }
            current.toString().trim().takeIf(String::isNotEmpty)?.let(statements::add)
            return statements
        }
    }
}
