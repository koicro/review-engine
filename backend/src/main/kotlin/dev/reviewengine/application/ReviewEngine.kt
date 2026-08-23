package dev.reviewengine.application

import dev.reviewengine.domain.Category
import dev.reviewengine.domain.DomainErrorCode
import dev.reviewengine.domain.DomainException
import dev.reviewengine.domain.Entity
import dev.reviewengine.domain.EntityRelation
import dev.reviewengine.domain.RelationType
import dev.reviewengine.domain.Review
import dev.reviewengine.domain.ReviewStatus
import dev.reviewengine.domain.Scale
import dev.reviewengine.domain.TemplateCriterion
import dev.reviewengine.domain.TemplateStatus
import dev.reviewengine.domain.TemplateVersion
import dev.reviewengine.persistence.Database
import java.sql.Connection
import java.sql.PreparedStatement
import java.sql.ResultSet
import java.sql.SQLException
import java.time.Clock
import java.time.Instant
import java.util.Base64
import java.util.UUID

class ReviewEngine(
    internal val database: Database,
    private val clock: Clock = Clock.systemUTC(),
    internal val pictureStorage: PictureStorage = PictureStorage.default(),
    private val idGenerator: () -> UUID = UUID::randomUUID,
) {
    internal fun now(): Instant = clock.instant()
    internal fun newId(): UUID = idGenerator()

    fun ready(): Boolean = runCatching {
        database.read { connection ->
            connection.createStatement().use { statement ->
                statement.executeQuery("SELECT 1").use { result -> result.next() && result.getInt(1) == 1 }
            }
        }
    }.getOrDefault(false)
}

internal fun requireNonBlank(value: String, field: String): String = value.trim().takeIf(String::isNotEmpty)
    ?: throw DomainException(
        DomainErrorCode.INVALID_ARGUMENT,
        "$field must not be blank",
        mapOf("field" to field),
    )

internal fun notFound(resource: String, id: Any): Nothing = throw DomainException(
    DomainErrorCode.NOT_FOUND,
    "$resource was not found",
    mapOf("resource" to resource, "id" to id.toString()),
)

internal fun conflict(message: String, vararg details: Pair<String, Any?>): Nothing = throw DomainException(
    DomainErrorCode.CONFLICT,
    message,
    details.associate { it.first to it.second.toString() },
)

internal inline fun <T> mapSqlConflict(block: () -> T): T = try {
    block()
} catch (exception: SQLException) {
    val text = exception.message.orEmpty()
    if (
        text.contains("UNIQUE constraint failed", ignoreCase = true) ||
        text.contains("FOREIGN KEY constraint failed", ignoreCase = true) ||
        text.contains("CHECK constraint failed", ignoreCase = true)
    ) {
        throw DomainException(DomainErrorCode.CONFLICT, "The write conflicts with existing data", cause = exception)
    }
    if (
        exception.errorCode == 5 || exception.errorCode == 517 ||
        text.contains("SQLITE_BUSY", ignoreCase = true) ||
        text.contains("database is locked", ignoreCase = true)
    ) {
        throw DomainException(
            DomainErrorCode.CONFLICT,
            "The database is busy; retry the request",
            mapOf("retryable" to "true"),
            exception,
        )
    }
    throw exception
}

internal fun decodeCursor(cursor: String?): Int {
    if (cursor.isNullOrBlank()) return 0
    val decoded = runCatching {
        String(Base64.getUrlDecoder().decode(cursor)).toInt()
    }.getOrNull()
    if (decoded == null || decoded < 0) {
        throw DomainException(DomainErrorCode.INVALID_ARGUMENT, "Invalid pagination cursor")
    }
    return decoded
}

internal fun encodeCursor(offset: Int): String = Base64.getUrlEncoder().withoutPadding()
    .encodeToString(offset.toString().toByteArray())

internal fun normalizeLimit(limit: Int?): Int = (limit ?: 50).coerceIn(1, 100)

internal fun ResultSet.uuid(column: String): UUID = UUID.fromString(getString(column))
internal fun ResultSet.uuidOrNull(column: String): UUID? = getString(column)?.let(UUID::fromString)
internal fun ResultSet.instant(column: String): Instant = Instant.parse(getString(column))
internal fun ResultSet.instantOrNull(column: String): Instant? = getString(column)?.let(Instant::parse)

internal fun ResultSet.toCategory(prefix: String = ""): Category = Category(
    id = uuid("${prefix}id"),
    name = getString("${prefix}name"),
    description = getString("${prefix}description"),
    activeTemplateVersionId = uuidOrNull("${prefix}active_template_version_id"),
    archivedAt = instantOrNull("${prefix}archived_at"),
    createdAt = instant("${prefix}created_at"),
    updatedAt = instant("${prefix}updated_at"),
    lockVersion = getLong("${prefix}lock_version"),
)

internal fun ResultSet.toTemplateVersion(prefix: String = ""): TemplateVersion = TemplateVersion(
    id = uuid("${prefix}id"),
    categoryId = uuid("${prefix}category_id"),
    version = getInt("${prefix}version"),
    status = TemplateStatus.fromDatabase(getString("${prefix}status")),
    publishedAt = instantOrNull("${prefix}published_at"),
    createdAt = instant("${prefix}created_at"),
    updatedAt = instant("${prefix}updated_at"),
    lockVersion = getLong("${prefix}lock_version"),
)

internal fun ResultSet.toTemplateCriterion(): TemplateCriterion = TemplateCriterion(
    templateVersionId = uuid("template_version_id"),
    criterionId = uuid("criterion_id"),
    name = getString("name"),
    description = getString("description"),
    scale = Scale.of(getString("min_value"), getString("max_value"), getString("step_value")),
    position = getInt("position"),
    required = getInt("required") != 0,
)

internal fun ResultSet.toEntity(prefix: String = ""): Entity = Entity(
    id = uuid("${prefix}id"),
    categoryId = uuid("${prefix}category_id"),
    name = getString("${prefix}name"),
    description = getString("${prefix}description"),
    archivedAt = instantOrNull("${prefix}archived_at"),
    createdAt = instant("${prefix}created_at"),
    updatedAt = instant("${prefix}updated_at"),
    lockVersion = getLong("${prefix}lock_version"),
)

internal fun ResultSet.toReview(prefix: String = ""): Review = Review(
    id = uuid("${prefix}id"),
    entityId = uuid("${prefix}entity_id"),
    reviewerId = uuid("${prefix}reviewer_id"),
    templateVersionId = uuid("${prefix}template_version_id"),
    reviewedAt = instant("${prefix}reviewed_at"),
    status = ReviewStatus.fromDatabase(getString("${prefix}status")),
    supersedesReviewId = uuidOrNull("${prefix}supersedes_review_id"),
    createdAt = instant("${prefix}created_at"),
    updatedAt = instant("${prefix}updated_at"),
    lockVersion = getLong("${prefix}lock_version"),
    hiddenAt = instantOrNull("${prefix}hidden_at"),
)

internal fun ResultSet.toRelationType(prefix: String = ""): RelationType = RelationType(
    id = uuid("${prefix}id"),
    key = getString("${prefix}key"),
    forwardLabel = getString("${prefix}forward_label"),
    inverseLabel = getString("${prefix}inverse_label"),
    hierarchical = getInt("${prefix}hierarchical") != 0,
    createdAt = instant("${prefix}created_at"),
)

internal fun ResultSet.toEntityRelation(prefix: String = ""): EntityRelation = EntityRelation(
    id = uuid("${prefix}id"),
    sourceEntityId = uuid("${prefix}source_entity_id"),
    targetEntityId = uuid("${prefix}target_entity_id"),
    relationTypeId = uuid("${prefix}relation_type_id"),
    createdAt = instant("${prefix}created_at"),
)

internal fun Connection.category(id: UUID): Category = prepareStatement(
    "SELECT * FROM category WHERE id = ?",
).use { statement ->
    statement.setString(1, id.toString())
    statement.executeQuery().use { result -> if (result.next()) result.toCategory() else notFound("Category", id) }
}

internal fun Connection.templateVersion(id: UUID): TemplateVersion = prepareStatement(
    "SELECT * FROM template_version WHERE id = ?",
).use { statement ->
    statement.setString(1, id.toString())
    statement.executeQuery().use { result -> if (result.next()) result.toTemplateVersion() else notFound("Template version", id) }
}

internal fun Connection.templateCriteria(id: UUID): List<TemplateCriterion> = prepareStatement(
    "SELECT * FROM template_criterion WHERE template_version_id = ? ORDER BY position, criterion_id",
).use { statement ->
    statement.setString(1, id.toString())
    statement.executeQuery().use { result -> buildList { while (result.next()) add(result.toTemplateCriterion()) } }
}

internal fun Connection.entity(id: UUID): Entity = prepareStatement(
    "SELECT * FROM entity WHERE id = ?",
).use { statement ->
    statement.setString(1, id.toString())
    statement.executeQuery().use { result -> if (result.next()) result.toEntity() else notFound("Entity", id) }
}

internal fun Connection.review(id: UUID): Review = prepareStatement(
    "SELECT * FROM review WHERE id = ?",
).use { statement ->
    statement.setString(1, id.toString())
    statement.executeQuery().use { result -> if (result.next()) result.toReview() else notFound("Review", id) }
}

internal fun Connection.relationType(id: UUID): RelationType = prepareStatement(
    "SELECT * FROM relation_type WHERE id = ?",
).use { statement ->
    statement.setString(1, id.toString())
    statement.executeQuery().use { result -> if (result.next()) result.toRelationType() else notFound("Relation type", id) }
}

internal fun PreparedStatement.setNullableString(index: Int, value: String?) {
    if (value == null) setNull(index, java.sql.Types.VARCHAR) else setString(index, value)
}
