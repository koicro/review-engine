package dev.reviewengine.application

import dev.reviewengine.domain.DomainErrorCode
import dev.reviewengine.domain.DomainException
import dev.reviewengine.domain.WebSession
import dev.reviewengine.domain.WebSessionIdentity
import dev.reviewengine.persistence.WebSessionRepository
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Duration
import java.time.Instant
import java.util.Base64

class IssuedBrowserSession(
    /** Opaque bearer secret intended for the Set-Cookie value. Never persist or log this value. */
    val rawId: String,
    val expiresAt: Instant,
)

private const val SESSION_RANDOM_BYTES: Int = 32
private const val DEFAULT_SESSION_PRUNE_BATCH_SIZE: Int = 100
private val MAXIMUM_BROWSER_SESSION_LIFETIME: Duration = Duration.ofDays(30)
private val browserSessionRandom = SecureRandom()

/**
 * Exchanges a current administrator or stored API credential for an opaque, persistent browser session.
 */
fun ReviewEngine.issueBrowserSession(
    credential: String,
    configuredAdminToken: String,
    lifetime: Duration,
): IssuedBrowserSession = mapSqlConflict {
    if (lifetime.isZero || lifetime.isNegative || lifetime > MAXIMUM_BROWSER_SESSION_LIFETIME) {
        throw DomainException(
            DomainErrorCode.INVALID_ARGUMENT,
            "Browser session lifetime must be positive and no longer than 30 days",
        )
    }
    val credentialHash = hashToken(credential)
    val adminHash = hashToken(configuredAdminToken)
    val identityKind = when {
        constantTimeHashEquals(credentialHash, adminHash) -> WebSessionIdentity.ADMIN
        isStoredTokenHashActive(credentialHash) -> WebSessionIdentity.ACCESS_TOKEN
        else -> throw DomainException(DomainErrorCode.UNAUTHORIZED, "The supplied credential is not active")
    }

    val rawId = "res_${Base64.getUrlEncoder().withoutPadding().encodeToString(randomSessionBytes())}"
    val createdAt = now()
    val expiresAt = try {
        createdAt.plus(lifetime)
    } catch (exception: ArithmeticException) {
        throw DomainException(DomainErrorCode.INVALID_ARGUMENT, "Browser session expiry is outside the supported range", cause = exception)
    }
    val session = WebSession(
        sessionHash = hashToken(rawId),
        identityKind = identityKind,
        credentialHash = credentialHash,
        createdAt = createdAt,
        expiresAt = expiresAt,
    )
    database.write { connection ->
        WebSessionRepository().prune(connection, createdAt, DEFAULT_SESSION_PRUNE_BATCH_SIZE)
        WebSessionRepository().insert(connection, session)
    }
    IssuedBrowserSession(rawId, expiresAt)
}

/** Validates both the session and the current authority behind it. */
fun ReviewEngine.isBrowserSessionActive(rawId: String, configuredAdminToken: String): Boolean {
    if (rawId.isBlank()) return false
    val session = database.read { connection ->
        WebSessionRepository().findActive(connection, hashToken(rawId), now())
    } ?: return false
    return when (session.identityKind) {
        WebSessionIdentity.ADMIN -> constantTimeHashEquals(session.credentialHash, hashToken(configuredAdminToken))
        WebSessionIdentity.ACCESS_TOKEN -> isStoredTokenHashActive(session.credentialHash)
    }
}

/** Logout revokes the persisted fingerprint; the raw cookie value is never queried or retained. */
fun ReviewEngine.revokeBrowserSession(rawId: String): Boolean {
    if (rawId.isBlank()) return false
    return database.write { connection ->
        WebSessionRepository().revoke(connection, hashToken(rawId), now())
    }
}

/** Explicit bounded maintenance hook for startup or scheduled cleanup. */
fun ReviewEngine.pruneWebSessions(limit: Int = DEFAULT_SESSION_PRUNE_BATCH_SIZE): Int = database.write { connection ->
    WebSessionRepository().prune(connection, now(), limit)
}

private fun randomSessionBytes(): ByteArray = ByteArray(SESSION_RANDOM_BYTES).also(browserSessionRandom::nextBytes)

private fun constantTimeHashEquals(left: String, right: String): Boolean = MessageDigest.isEqual(
    left.toByteArray(StandardCharsets.US_ASCII),
    right.toByteArray(StandardCharsets.US_ASCII),
)
