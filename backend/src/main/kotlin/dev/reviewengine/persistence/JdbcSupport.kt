package dev.reviewengine.persistence

import dev.reviewengine.domain.DomainErrorCode
import dev.reviewengine.domain.DomainException
import java.sql.PreparedStatement
import java.sql.ResultSet
import java.time.Instant
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeFormatterBuilder
import java.util.UUID

internal fun PreparedStatement.setUuid(index: Int, value: UUID) = setString(index, value.toString())

internal fun PreparedStatement.setNullableUuid(index: Int, value: UUID?) = setString(index, value?.toString())

/**
 * SQLite compares TEXT timestamps lexicographically, so every stored instant must use one fixed-width UTC form.
 */
private val databaseInstantFormatter: DateTimeFormatter = DateTimeFormatterBuilder()
    .appendInstant(9)
    .toFormatter()

internal fun Instant.toDatabaseTimestamp(): String = databaseInstantFormatter.format(this)

internal fun PreparedStatement.setInstant(index: Int, value: Instant) = setString(index, value.toDatabaseTimestamp())

internal fun PreparedStatement.setNullableInstant(index: Int, value: Instant?) = setString(index, value?.toDatabaseTimestamp())

internal fun ResultSet.uuid(column: String): UUID = UUID.fromString(getString(column))

internal fun ResultSet.nullableUuid(column: String): UUID? = getString(column)?.let(UUID::fromString)

internal fun ResultSet.instant(column: String): Instant = Instant.parse(getString(column))

internal fun ResultSet.nullableInstant(column: String): Instant? = getString(column)?.let(Instant::parse)

internal inline fun <T> ResultSet.mapRows(mapper: (ResultSet) -> T): List<T> = buildList {
    while (next()) add(mapper(this@mapRows))
}

internal fun optimisticLockFailure(resource: String, id: UUID, expectedVersion: Long): Nothing = throw DomainException(
    DomainErrorCode.OPTIMISTIC_LOCK_CONFLICT,
    "$resource was changed by another operation",
    mapOf("id" to id.toString(), "expectedLockVersion" to expectedVersion.toString()),
)

internal fun notFound(resource: String, id: UUID): Nothing = throw DomainException(
    DomainErrorCode.NOT_FOUND,
    "$resource was not found",
    mapOf("id" to id.toString()),
)
