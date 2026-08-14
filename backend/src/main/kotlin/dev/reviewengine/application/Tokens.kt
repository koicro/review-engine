package dev.reviewengine.application

import dev.reviewengine.persistence.AccessTokenRepository
import dev.reviewengine.persistence.toDatabaseTimestamp
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.UUID

/** One-time secret result; deliberately not a data class so toString never renders the token. */
class IssuedToken(val record: TokenRecord, val token: String)

fun hashToken(token: String): String = MessageDigest.getInstance("SHA-256")
    .digest(token.toByteArray(StandardCharsets.UTF_8))
    .joinToString("") { byte -> "%02x".format(byte) }

fun ReviewEngine.isStoredTokenActive(token: String): Boolean = isStoredTokenHashActive(hashToken(token))

/** Checks a fingerprint without requiring callers to retain or re-expose the raw token. */
fun ReviewEngine.isStoredTokenHashActive(tokenHash: String): Boolean = database.read { connection ->
    AccessTokenRepository().findActiveByHash(connection, tokenHash) != null
}

fun ReviewEngine.listAccessTokens(): List<TokenRecord> = database.read { connection ->
    connection.createStatement().use { statement ->
        statement.executeQuery("SELECT id, name, created_at, revoked_at FROM access_token ORDER BY created_at DESC, id DESC").use { result ->
            buildList {
                while (result.next()) {
                    add(TokenRecord(result.uuid("id"), result.getString("name"), result.instant("created_at"), result.instantOrNull("revoked_at")))
                }
            }
        }
    }
}

fun ReviewEngine.issueAccessToken(name: String): IssuedToken = mapSqlConflict {
    database.write { connection ->
        val random = ByteArray(32).also(SecureRandom()::nextBytes)
        val token = "re_${Base64.getUrlEncoder().withoutPadding().encodeToString(random)}"
        val record = TokenRecord(newId(), requireNonBlank(name, "name"), now(), null)
        connection.prepareStatement(
            "INSERT INTO access_token(id, name, token_hash, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL)",
        ).use { statement ->
            statement.setString(1, record.id.toString())
            statement.setString(2, record.name)
            statement.setString(3, hashToken(token))
            statement.setString(4, record.createdAt.toDatabaseTimestamp())
            statement.executeUpdate()
        }
        IssuedToken(record, token)
    }
}

fun ReviewEngine.revokeAccessToken(id: UUID): TokenRecord = mapSqlConflict {
    database.write { connection ->
        val existing = connection.prepareStatement("SELECT id, name, created_at, revoked_at FROM access_token WHERE id = ?").use { statement ->
            statement.setString(1, id.toString())
            statement.executeQuery().use { result ->
                if (!result.next()) notFound("Access token", id)
                TokenRecord(result.uuid("id"), result.getString("name"), result.instant("created_at"), result.instantOrNull("revoked_at"))
            }
        }
        if (existing.revokedAt != null) return@write existing
        val revokedAt = now()
        connection.prepareStatement("UPDATE access_token SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").use { statement ->
            statement.setString(1, revokedAt.toDatabaseTimestamp())
            statement.setString(2, id.toString())
            statement.executeUpdate()
        }
        existing.copy(revokedAt = revokedAt)
    }
}
