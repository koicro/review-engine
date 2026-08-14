package dev.reviewengine.persistence

import dev.reviewengine.domain.AccessToken
import java.sql.Connection
import java.sql.ResultSet
import java.time.Instant
import java.util.UUID

class AccessTokenRepository {
    fun insert(connection: Connection, token: AccessToken) {
        connection.prepareStatement(
            "INSERT INTO access_token(id, name, token_hash, created_at, revoked_at) VALUES (?, ?, ?, ?, ?)",
        ).use { statement ->
            statement.setUuid(1, token.id)
            statement.setString(2, token.name)
            statement.setString(3, token.tokenHash)
            statement.setInstant(4, token.createdAt)
            statement.setNullableInstant(5, token.revokedAt)
            statement.executeUpdate()
        }
    }

    fun findActiveByHash(connection: Connection, tokenHash: String): AccessToken? = connection.prepareStatement(
        "SELECT * FROM access_token WHERE token_hash = ? AND revoked_at IS NULL",
    ).use { statement ->
        statement.setString(1, tokenHash)
        statement.executeQuery().use { result -> if (result.next()) result.toAccessToken() else null }
    }

    fun revoke(connection: Connection, id: UUID, revokedAt: Instant): Boolean = connection.prepareStatement(
        "UPDATE access_token SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
    ).use { statement ->
        statement.setInstant(1, revokedAt)
        statement.setUuid(2, id)
        statement.executeUpdate() == 1
    }

    private fun ResultSet.toAccessToken() = AccessToken(
        id = uuid("id"),
        name = getString("name"),
        tokenHash = getString("token_hash"),
        createdAt = instant("created_at"),
        revokedAt = nullableInstant("revoked_at"),
    )
}
