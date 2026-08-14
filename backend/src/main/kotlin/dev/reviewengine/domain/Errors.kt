package dev.reviewengine.domain

/** Stable, transport-neutral error identifiers used by the domain and persistence layers. */
enum class DomainErrorCode {
    INVALID_ARGUMENT,
    INVALID_DECIMAL,
    INVALID_SCALE,
    INVALID_TICK_INDEX,
    REQUIRED_SCORE_MISSING,
    UNKNOWN_CRITERION,
    DUPLICATE_CRITERION,
    CATEGORY_MISMATCH,
    INVALID_STATE_TRANSITION,
    IMMUTABLE_RESOURCE,
    NOT_FOUND,
    CONFLICT,
    OPTIMISTIC_LOCK_CONFLICT,
    HIERARCHY_CYCLE,
    IMPORT_INVALID,
    UNAUTHORIZED,
}

/**
 * A domain failure that deliberately carries no HTTP, Ktor, or persistence-specific type.
 * API adapters can map [code] to their public error contract.
 */
class DomainException(
    val code: DomainErrorCode,
    override val message: String,
    val details: Map<String, String> = emptyMap(),
    cause: Throwable? = null,
) : RuntimeException(message, cause)

internal fun domainFailure(
    code: DomainErrorCode,
    message: String,
    vararg details: Pair<String, Any?>,
): Nothing = throw DomainException(
    code = code,
    message = message,
    details = details.associate { (key, value) -> key to value.toString() },
)
