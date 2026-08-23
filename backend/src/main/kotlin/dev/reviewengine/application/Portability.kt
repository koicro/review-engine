package dev.reviewengine.application

import dev.reviewengine.domain.DomainErrorCode
import dev.reviewengine.domain.DomainException
import dev.reviewengine.domain.Scale
import dev.reviewengine.persistence.Database
import dev.reviewengine.persistence.WebSessionRepository
import dev.reviewengine.persistence.toDatabaseTimestamp
import java.sql.Connection
import java.sql.SQLException
import java.time.Instant
import java.util.UUID
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

internal const val MAX_IMPORT_ROWS_PER_TABLE: Int = 5_000_000
internal const val MAX_IMPORT_ROWS_TOTAL: Long = 10_000_000L
internal const val MAX_IMPORT_ERRORS: Int = 100
internal const val MAX_CRITERIA_PER_TEMPLATE: Int = 100
internal const val MAX_IMPORT_NAME_LENGTH: Int = 256
internal const val MAX_IMPORT_DESCRIPTION_LENGTH: Int = 16_384
private val SUPPORTED_IMPORT_FORMAT_VERSIONS: Set<String> = setOf("1.0", EXPORT_FORMAT_VERSION)

private const val MAX_IMPORT_IDENTIFIER_LENGTH: Int = 64
private const val MAX_IMPORT_DECIMAL_LENGTH: Int = 128
private const val MAX_IMPORT_TIMESTAMP_LENGTH: Int = 64

private data class ExportTable(val name: String, val orderBy: String)

private val exportTables = listOf(
    ExportTable("category", "id"),
    ExportTable("criterion", "id"),
    ExportTable("template_version", "category_id, version, id"),
    ExportTable("template_criterion", "template_version_id, position, criterion_id"),
    ExportTable("entity", "id"),
    ExportTable("reviewer", "id"),
    ExportTable("review", "id"),
    ExportTable("score", "review_id, criterion_id"),
    ExportTable("relation_type", "id"),
    ExportTable("entity_relation", "id"),
)

private val importOrder = listOf(
    "category",
    "criterion",
    "template_version",
    "template_criterion",
    "entity",
    "reviewer",
    "review",
    "score",
    "relation_type",
    "entity_relation",
)

fun ReviewEngine.exportJson(): JsonObject = database.read { connection ->
    buildJsonObject {
        put("format", "review-engine")
        put("formatVersion", EXPORT_FORMAT_VERSION)
        put("exportedAt", now().toDatabaseTimestamp())
        put("data", buildJsonObject {
            exportTables.forEach { table ->
                put(table.name, exportTable(connection, table))
            }
        })
    }
}

fun ReviewEngine.validateImport(payload: JsonElement): ImportValidation {
    val errors = mutableListOf<ImportIssue>()
    val root = payload as? JsonObject
    if (root == null) {
        errors.addIssue("$", "INVALID_DOCUMENT", "Import document must be a JSON object")
        return ImportValidation(false, errors, emptyMap(), EXPORT_FORMAT_VERSION)
    }
    val format = root["format"]?.asString()
    if (format != "review-engine") errors.addIssue("$.format", "INVALID_FORMAT", "Expected review-engine")
    val formatVersion = root["formatVersion"]?.asString().orEmpty()
    if (formatVersion !in SUPPORTED_IMPORT_FORMAT_VERSIONS) {
        errors.addIssue(
            "$.formatVersion",
            "UNSUPPORTED_VERSION",
            "Supported format versions are ${SUPPORTED_IMPORT_FORMAT_VERSIONS.sorted().joinToString()}",
        )
    }
    val data = root["data"] as? JsonObject
    if (data == null) {
        errors.addIssue("$.data", "MISSING_DATA", "The data object is required")
        return ImportValidation(false, errors, emptyMap(), formatVersion.ifBlank { EXPORT_FORMAT_VERSION })
    }
    val counts = linkedMapOf<String, Int>()
    val criterionCounts = mutableMapOf<String, Int>()
    var totalRows = 0L
    importOrder.forEach { table ->
        val rows = data[table]
        if (rows !is JsonArray) {
            errors.addIssue("$.data.$table", "INVALID_TABLE", "$table must be an array")
        } else {
            counts[table] = rows.size
            totalRows += rows.size.toLong()
            if (rows.size > MAX_IMPORT_ROWS_PER_TABLE) {
                errors.addIssue(
                    "$.data.$table",
                    "ROW_LIMIT_EXCEEDED",
                    "$table exceeds the limit of $MAX_IMPORT_ROWS_PER_TABLE rows",
                )
            } else {
                rows.forEachIndexed { index, row ->
                    if (errors.size >= MAX_IMPORT_ERRORS) return@forEachIndexed
                    val path = "$.data.$table[$index]"
                    if (row !is JsonObject) {
                        errors.addIssue(path, "INVALID_ROW", "Row must be an object")
                    } else {
                        val schema = portableSchema.getValue(table)
                        val required = schema.filterValues { it.required }.keys +
                            if (table == "review" && formatVersion != "1.0") setOf("hidden_at") else emptySet()
                        val missing = required - row.keys
                        val unknown = row.keys - schema.keys
                        if (missing.isNotEmpty()) {
                            errors.addIssue(path, "MISSING_COLUMNS", "Missing columns: ${missing.sorted().joinToString()}")
                        }
                        if (unknown.isNotEmpty()) {
                            errors.addIssue(path, "UNKNOWN_COLUMNS", "Unknown columns: ${unknown.sorted().joinToString()}")
                        }
                        validatePortableFormats(table, row, path, errors)
                        if (table == "template_criterion") {
                            row["template_version_id"].portableString()?.let { templateVersionId ->
                                val count = (criterionCounts[templateVersionId] ?: 0) + 1
                                criterionCounts[templateVersionId] = count
                                if (count == MAX_CRITERIA_PER_TEMPLATE + 1) {
                                    errors.addIssue(
                                        "$.data.template_criterion",
                                        "CRITERION_LIMIT_EXCEEDED",
                                        "A template version exceeds the limit of $MAX_CRITERIA_PER_TEMPLATE criteria",
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    if (totalRows > MAX_IMPORT_ROWS_TOTAL) {
        errors.addIssue(
            "$.data",
            "ROW_LIMIT_EXCEEDED",
            "Import exceeds the total limit of $MAX_IMPORT_ROWS_TOTAL rows",
        )
    }
    if (errors.isEmpty()) {
        try {
            Database("jdbc:sqlite::memory:").use { temporary ->
                temporary.migrate()
                temporary.write { connection ->
                    requireEmptyForImport(connection)
                    importOrder.forEach { table ->
                        data.getValue(table).jsonArray.forEach { row -> insertRow(connection, table, row.jsonObject) }
                    }
                    validateImportedSemantics(connection)
                }
            }
        } catch (exception: DomainException) {
            errors.addIssue("$.data", exception.code.name, exception.message)
        } catch (exception: SQLException) {
            errors.addIssue("$.data", "CONSTRAINT_VIOLATION", "Imported rows violate schema or reference constraints")
        } catch (exception: RuntimeException) {
            errors.addIssue("$.data", "INVALID_DATA", exception.message ?: "Imported data is invalid")
        }
    }
    return ImportValidation(errors.isEmpty(), errors, counts, formatVersion.ifBlank { EXPORT_FORMAT_VERSION })
}

fun ReviewEngine.importJson(payload: JsonElement): Map<String, Int> {
    val validation = validateImport(payload)
    if (!validation.valid) {
        throw DomainException(
            DomainErrorCode.IMPORT_INVALID,
            "Import validation failed",
            mapOf("errors" to validation.errors.joinToString("; ") { "${it.path}: ${it.message}" }),
        )
    }
    val data = payload.jsonObject.getValue("data").jsonObject
    return mapSqlConflict {
        database.write { connection ->
            requireEmptyForImport(connection)
            importOrder.forEach { table ->
                val rows = data.getValue(table).jsonArray
                rows.forEach { row -> insertRow(connection, table, row.jsonObject) }
            }
            // Operational browser authority is deliberately not portable across a restore boundary.
            WebSessionRepository().deleteAll(connection)
            validation.counts
        }
    }
}

private fun exportTable(connection: Connection, table: ExportTable): JsonArray = connection.createStatement().use { statement ->
    statement.executeQuery("SELECT * FROM ${table.name} ORDER BY ${table.orderBy}").use { result ->
        val metadata = result.metaData
        buildJsonArray {
            while (result.next()) {
                add(
                    buildJsonObject {
                        for (index in 1..metadata.columnCount) {
                            val name = metadata.getColumnName(index)
                            val value = result.getObject(index)
                            when (value) {
                                null -> put(name, JsonNull)
                                is Number -> put(name, JsonPrimitive(value))
                                is Boolean -> put(name, JsonPrimitive(value))
                                else -> put(name, JsonPrimitive(value.toString()))
                            }
                        }
                    },
                )
            }
        }
    }
}

private fun requireEmptyForImport(connection: Connection) {
    val tableWithData = listOf(
        "category", "criterion", "template_version", "template_criterion", "entity", "review", "score", "relation_type", "entity_relation",
    ).firstOrNull { table ->
        connection.createStatement().use { statement -> statement.executeQuery("SELECT EXISTS(SELECT 1 FROM $table LIMIT 1)").use { it.next(); it.getInt(1) != 0 } }
    }
    if (tableWithData != null) conflict("Imports can only restore into an empty database", "table" to tableWithData)
    connection.createStatement().use { it.executeUpdate("DELETE FROM reviewer") }
}

private fun insertRow(connection: Connection, table: String, row: JsonObject) {
    val schema = portableSchema.getValue(table)
    val columns = schema.keys.toList()
    val missing = schema.filterValues { it.required }.keys - row.keys
    val unknown = row.keys - schema.keys
    if (missing.isNotEmpty() || unknown.isNotEmpty()) {
        throw DomainException(
            DomainErrorCode.IMPORT_INVALID,
            "Import row columns do not match the schema",
            mapOf(
                "table" to table,
                "missing" to missing.joinToString(","),
                "unknown" to unknown.joinToString(","),
            ),
        )
    }
    val placeholders = columns.joinToString(",") { "?" }
    connection.prepareStatement("INSERT INTO $table(${columns.joinToString(",")}) VALUES ($placeholders)").use { statement ->
        columns.forEachIndexed { index, column ->
            val value = row[column] ?: JsonNull
            when {
                value is JsonNull -> statement.setObject(index + 1, null)
                schema.getValue(column).kind == PortableKind.UUID -> statement.setString(
                    index + 1,
                    UUID.fromString(value.jsonPrimitive.content).toString(),
                )
                schema.getValue(column).kind == PortableKind.INSTANT -> statement.setString(
                    index + 1,
                    Instant.parse(value.jsonPrimitive.content).toDatabaseTimestamp(),
                )
                schema.getValue(column).kind == PortableKind.INTEGER -> statement.setLong(
                    index + 1,
                    value.jsonPrimitive.longOrNull
                        ?: throw DomainException(DomainErrorCode.IMPORT_INVALID, "$table.$column must be an integer"),
                )
                else -> statement.setString(index + 1, value.jsonPrimitive.content)
            }
        }
        statement.executeUpdate()
    }
}

private fun validatePortableFormats(
    table: String,
    row: JsonObject,
    path: String,
    errors: MutableList<ImportIssue>,
) {
    portableSchema.getValue(table).forEach { (column, definition) ->
        if (errors.size >= MAX_IMPORT_ERRORS) return
        val value = row[column] ?: return@forEach
        val columnPath = "$path.$column"
        if (value is JsonNull) {
            if (!definition.nullable) errors.addIssue(columnPath, "NULL_NOT_ALLOWED", "$column must not be null")
            return@forEach
        }
        val primitive = value as? JsonPrimitive
        if (primitive == null) {
            errors.addIssue(columnPath, "INVALID_TYPE", "$column must be a primitive value")
            return@forEach
        }
        when (definition.kind) {
            PortableKind.TEXT, PortableKind.UUID, PortableKind.INSTANT -> {
                if (!primitive.isString) {
                    errors.addIssue(columnPath, "INVALID_TYPE", "$column must be a string")
                    return@forEach
                }
                val content = primitive.content
                if (definition.maxLength != null && content.length > definition.maxLength) {
                    errors.addIssue(
                        columnPath,
                        "STRING_TOO_LONG",
                        "$column must contain at most ${definition.maxLength} characters",
                    )
                    return@forEach
                }
                if (definition.nonBlank && content.isBlank()) {
                    errors.addIssue(columnPath, "BLANK_STRING", "$column must not be blank")
                }
                if (definition.allowedValues != null && content !in definition.allowedValues) {
                    errors.addIssue(columnPath, "INVALID_VALUE", "$column has an unsupported value")
                }
                if (definition.kind == PortableKind.UUID) {
                    val parsed = runCatching { UUID.fromString(content) }.getOrNull()
                    if (parsed == null || !parsed.toString().equals(content, ignoreCase = true)) {
                        errors.addIssue(columnPath, "INVALID_UUID", "$column must be a canonical UUID")
                    }
                }
                if (definition.kind == PortableKind.INSTANT && runCatching { Instant.parse(content) }.isFailure) {
                    errors.addIssue(columnPath, "INVALID_TIMESTAMP", "$column must be an ISO 8601 timestamp")
                }
            }
            PortableKind.INTEGER -> {
                if (primitive.isString || primitive.longOrNull == null) {
                    errors.addIssue(columnPath, "INVALID_TYPE", "$column must be a JSON integer")
                    return@forEach
                }
                val integer = primitive.longOrNull!!
                if (
                    definition.minimumValue?.let { integer < it } == true ||
                    definition.maximumValue?.let { integer > it } == true
                ) {
                    errors.addIssue(columnPath, "OUT_OF_RANGE", "$column is outside the supported range")
                }
            }
        }
    }
    if (table == "template_criterion") {
        val min = row["min_value"].portableString()
        val max = row["max_value"].portableString()
        val step = row["step_value"].portableString()
        if (min != null && max != null && step != null) {
            try {
                Scale.of(min, max, step)
            } catch (exception: DomainException) {
                errors.addIssue(path, exception.code.name, exception.message)
            }
        }
    }
}

private fun validateImportedSemantics(connection: Connection) {
    connection.createStatement().use { statement ->
        statement.executeQuery(
            "SELECT archived_at FROM reviewer WHERE id = '$DEFAULT_REVIEWER_ID'",
        ).use { result ->
            if (!result.next() || result.getString("archived_at") != null) {
                conflict("The active default reviewer is required", "reviewerId" to DEFAULT_REVIEWER_ID)
            }
        }
        statement.executeQuery(
            """
            SELECT c.id
            FROM category c
            JOIN template_version tv ON tv.id = c.active_template_version_id
            WHERE c.active_template_version_id IS NOT NULL
              AND (tv.category_id <> c.id OR tv.status <> 'published')
            LIMIT 1
            """.trimIndent(),
        ).use { result ->
            if (result.next()) conflict("A category active template must be a published version from that category", "categoryId" to result.getString(1))
        }
        statement.executeQuery(
            """
            SELECT r.id
            FROM review r
            JOIN entity e ON e.id = r.entity_id
            JOIN template_version tv ON tv.id = r.template_version_id
            WHERE e.category_id <> tv.category_id OR tv.status = 'draft'
            LIMIT 1
            """.trimIndent(),
        ).use { result ->
            if (result.next()) conflict("A review must use a published or retired template from its entity category", "reviewId" to result.getString(1))
        }
        statement.executeQuery(
            "SELECT id FROM review WHERE status = 'draft' AND hidden_at IS NOT NULL LIMIT 1",
        ).use { result ->
            if (result.next()) conflict("Draft reviews cannot be hidden", "reviewId" to result.getString(1))
        }
        statement.executeQuery(
            """
            SELECT tc.template_version_id, tc.criterion_id
            FROM template_criterion tc
            JOIN template_version tv ON tv.id = tc.template_version_id
            JOIN criterion c ON c.id = tc.criterion_id
            WHERE tv.category_id <> c.category_id
            LIMIT 1
            """.trimIndent(),
        ).use { result ->
            if (result.next()) {
                conflict(
                    "A template criterion must belong to the template category",
                    "templateVersionId" to result.getString(1),
                    "criterionId" to result.getString(2),
                )
            }
        }
        statement.executeQuery(
            """
            SELECT replacement.id
            FROM review replacement
            JOIN review original ON original.id = replacement.supersedes_review_id
            WHERE replacement.supersedes_review_id IS NOT NULL
              AND (
                replacement.status NOT IN ('final', 'superseded')
                OR original.status <> 'superseded'
                OR replacement.entity_id <> original.entity_id
                OR replacement.template_version_id <> original.template_version_id
              )
            LIMIT 1
            """.trimIndent(),
        ).use { result ->
            if (result.next()) conflict("A review revision chain is inconsistent", "reviewId" to result.getString(1))
        }
        statement.executeQuery(
            """
            SELECT original.id
            FROM review original
            WHERE original.status = 'superseded'
              AND NOT EXISTS (SELECT 1 FROM review replacement WHERE replacement.supersedes_review_id = original.id)
            LIMIT 1
            """.trimIndent(),
        ).use { result ->
            if (result.next()) conflict("A superseded review has no replacement", "reviewId" to result.getString(1))
        }
        statement.executeQuery(
            """
            WITH RECURSIVE ancestry(start_id, node_id) AS (
                SELECT id, supersedes_review_id
                FROM review
                WHERE supersedes_review_id IS NOT NULL
                UNION
                SELECT ancestry.start_id, parent.supersedes_review_id
                FROM ancestry
                JOIN review parent ON parent.id = ancestry.node_id
                WHERE parent.supersedes_review_id IS NOT NULL
            )
            SELECT start_id FROM ancestry WHERE start_id = node_id LIMIT 1
            """.trimIndent(),
        ).use { result ->
            if (result.next()) conflict("Review revision chains cannot contain a cycle", "reviewId" to result.getString(1))
        }
        statement.executeQuery(
            """
            SELECT template_version_id, COUNT(*) AS criterion_count
            FROM template_criterion
            GROUP BY template_version_id
            HAVING COUNT(*) > $MAX_CRITERIA_PER_TEMPLATE
            LIMIT 1
            """.trimIndent(),
        ).use { result ->
            if (result.next()) {
                conflict(
                    "A template version exceeds the limit of $MAX_CRITERIA_PER_TEMPLATE criteria",
                    "templateVersionId" to result.getString("template_version_id"),
                )
            }
        }
        statement.executeQuery(
            """
            SELECT r.id
            FROM review r
            WHERE r.status IN ('final', 'superseded')
              AND EXISTS (
                SELECT 1 FROM template_criterion tc
                WHERE tc.template_version_id = r.template_version_id AND tc.required = 1
                  AND NOT EXISTS (
                    SELECT 1 FROM score s WHERE s.review_id = r.id AND s.criterion_id = tc.criterion_id
                  )
              )
            LIMIT 1
            """.trimIndent(),
        ).use { result ->
            if (result.next()) conflict("A final review is missing a required score", "reviewId" to result.getString(1))
        }
        statement.executeQuery(
            """
            WITH RECURSIVE hierarchy(relation_type_id, start_id, node_id) AS (
                SELECT er.relation_type_id, er.source_entity_id, er.target_entity_id
                FROM entity_relation er
                JOIN relation_type rt ON rt.id = er.relation_type_id
                WHERE rt.hierarchical = 1
                UNION
                SELECT hierarchy.relation_type_id, hierarchy.start_id, er.target_entity_id
                FROM hierarchy
                JOIN entity_relation er
                  ON er.relation_type_id = hierarchy.relation_type_id
                 AND er.source_entity_id = hierarchy.node_id
            )
            SELECT relation_type_id FROM hierarchy WHERE start_id = node_id LIMIT 1
            """.trimIndent(),
        ).use { result ->
            if (result.next()) {
                throw DomainException(
                    DomainErrorCode.HIERARCHY_CYCLE,
                    "Imported hierarchical relations contain a cycle",
                    mapOf("relationTypeId" to result.getString(1)),
                )
            }
        }
    }

    connection.createStatement().use { statement ->
        statement.executeQuery(
            """
            SELECT s.review_id, s.criterion_id, s.tick_index,
                   tc.min_value, tc.max_value, tc.step_value
            FROM score s
            JOIN review r ON r.id = s.review_id
            LEFT JOIN template_criterion tc
              ON tc.template_version_id = r.template_version_id
             AND tc.criterion_id = s.criterion_id
            """.trimIndent(),
        ).use { result ->
            while (result.next()) {
                val maxValue = result.getString("max_value")
                    ?: conflict(
                        "A score criterion is not defined by its review template",
                        "reviewId" to result.getString("review_id"),
                        "criterionId" to result.getString("criterion_id"),
                    )
                Scale.of(result.getString("min_value"), maxValue, result.getString("step_value"))
                    .requireTick(result.getLong("tick_index"))
            }
        }
    }
}

private fun JsonElement.asString(): String? = (this as? JsonPrimitive)?.takeIf(JsonPrimitive::isString)?.content

private fun JsonElement?.portableString(): String? = (this as? JsonPrimitive)?.takeIf(JsonPrimitive::isString)?.content

private fun MutableList<ImportIssue>.addIssue(path: String, code: String, message: String) {
    if (size < MAX_IMPORT_ERRORS) add(ImportIssue(path, code, message))
}

private enum class PortableKind { TEXT, UUID, INSTANT, INTEGER }

private data class PortableColumn(
    val kind: PortableKind,
    val nullable: Boolean = false,
    val required: Boolean = true,
    val maxLength: Int? = null,
    val nonBlank: Boolean = false,
    val minimumValue: Long? = null,
    val maximumValue: Long? = null,
    val allowedValues: Set<String>? = null,
)

private fun portableText(
    maxLength: Int,
    nullable: Boolean = false,
    nonBlank: Boolean = false,
    allowedValues: Set<String>? = null,
) = PortableColumn(
    kind = PortableKind.TEXT,
    nullable = nullable,
    maxLength = maxLength,
    nonBlank = nonBlank,
    allowedValues = allowedValues,
)

private fun portableUuid(nullable: Boolean = false) = PortableColumn(
    kind = PortableKind.UUID,
    nullable = nullable,
    maxLength = 36,
)

private fun portableInstant(nullable: Boolean = false, required: Boolean = true) = PortableColumn(
    kind = PortableKind.INSTANT,
    nullable = nullable,
    required = required,
    maxLength = MAX_IMPORT_TIMESTAMP_LENGTH,
)

private fun portableInteger(minimum: Long = 0, maximum: Long? = null) = PortableColumn(
    kind = PortableKind.INTEGER,
    minimumValue = minimum,
    maximumValue = maximum,
)

private val portableSchema = mapOf(
    "category" to linkedMapOf(
        "id" to portableUuid(),
        "name" to portableText(MAX_IMPORT_NAME_LENGTH, nonBlank = true),
        "description" to portableText(MAX_IMPORT_DESCRIPTION_LENGTH, nullable = true),
        "active_template_version_id" to portableUuid(nullable = true),
        "archived_at" to portableInstant(nullable = true),
        "created_at" to portableInstant(),
        "updated_at" to portableInstant(),
        "lock_version" to portableInteger(),
    ),
    "criterion" to linkedMapOf(
        "id" to portableUuid(),
        "category_id" to portableUuid(),
        "created_at" to portableInstant(),
    ),
    "template_version" to linkedMapOf(
        "id" to portableUuid(),
        "category_id" to portableUuid(),
        "version" to portableInteger(minimum = 1, maximum = Int.MAX_VALUE.toLong()),
        "status" to portableText(
            maxLength = MAX_IMPORT_IDENTIFIER_LENGTH,
            allowedValues = setOf("draft", "published", "retired"),
        ),
        "published_at" to portableInstant(nullable = true),
        "created_at" to portableInstant(),
        "updated_at" to portableInstant(),
        "lock_version" to portableInteger(),
    ),
    "template_criterion" to linkedMapOf(
        "template_version_id" to portableUuid(),
        "criterion_id" to portableUuid(),
        "name" to portableText(MAX_IMPORT_NAME_LENGTH, nonBlank = true),
        "description" to portableText(MAX_IMPORT_DESCRIPTION_LENGTH, nullable = true),
        "min_value" to portableText(MAX_IMPORT_DECIMAL_LENGTH, nonBlank = true),
        "max_value" to portableText(MAX_IMPORT_DECIMAL_LENGTH, nonBlank = true),
        "step_value" to portableText(MAX_IMPORT_DECIMAL_LENGTH, nonBlank = true),
        "position" to portableInteger(maximum = Int.MAX_VALUE.toLong()),
        "required" to portableInteger(maximum = 1),
    ),
    "entity" to linkedMapOf(
        "id" to portableUuid(),
        "category_id" to portableUuid(),
        "name" to portableText(MAX_IMPORT_NAME_LENGTH, nonBlank = true),
        "description" to portableText(MAX_IMPORT_DESCRIPTION_LENGTH, nullable = true),
        "archived_at" to portableInstant(nullable = true),
        "created_at" to portableInstant(),
        "updated_at" to portableInstant(),
        "lock_version" to portableInteger(),
    ),
    "reviewer" to linkedMapOf(
        "id" to portableUuid(),
        "display_name" to portableText(MAX_IMPORT_NAME_LENGTH, nonBlank = true),
        "archived_at" to portableInstant(nullable = true),
        "created_at" to portableInstant(),
    ),
    "review" to linkedMapOf(
        "id" to portableUuid(),
        "entity_id" to portableUuid(),
        "reviewer_id" to portableUuid(),
        "template_version_id" to portableUuid(),
        "reviewed_at" to portableInstant(),
        "status" to portableText(
            maxLength = MAX_IMPORT_IDENTIFIER_LENGTH,
            allowedValues = setOf("draft", "final", "superseded"),
        ),
        "supersedes_review_id" to portableUuid(nullable = true),
        "created_at" to portableInstant(),
        "updated_at" to portableInstant(),
        "lock_version" to portableInteger(),
        // Added in schema migration V002. Missing means visible for exports made before V002.
        "hidden_at" to portableInstant(nullable = true, required = false),
    ),
    "score" to linkedMapOf(
        "review_id" to portableUuid(),
        "criterion_id" to portableUuid(),
        "tick_index" to portableInteger(),
    ),
    "relation_type" to linkedMapOf(
        "id" to portableUuid(),
        "key" to portableText(MAX_IMPORT_IDENTIFIER_LENGTH, nonBlank = true),
        "forward_label" to portableText(MAX_IMPORT_NAME_LENGTH, nonBlank = true),
        "inverse_label" to portableText(MAX_IMPORT_NAME_LENGTH, nonBlank = true),
        "hierarchical" to portableInteger(maximum = 1),
        "created_at" to portableInstant(),
    ),
    "entity_relation" to linkedMapOf(
        "id" to portableUuid(),
        "source_entity_id" to portableUuid(),
        "target_entity_id" to portableUuid(),
        "relation_type_id" to portableUuid(),
        "created_at" to portableInstant(),
    ),
)
