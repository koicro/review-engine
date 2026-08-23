package dev.reviewengine.api

import dev.reviewengine.application.ReviewEngine
import dev.reviewengine.application.PictureStorage
import dev.reviewengine.application.isBrowserSessionActive
import dev.reviewengine.application.isStoredTokenActive
import dev.reviewengine.domain.DomainErrorCode
import dev.reviewengine.domain.DomainException
import dev.reviewengine.persistence.Database
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.auth.HttpAuthHeader
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.Application
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.install
import io.ktor.server.auth.Authentication
import io.ktor.server.auth.UserIdPrincipal
import io.ktor.server.auth.bearer
import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty
import io.ktor.server.plugins.calllogging.CallLogging
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.plugins.cors.routing.CORS
import io.ktor.server.plugins.defaultheaders.DefaultHeaders
import io.ktor.server.plugins.PayloadTooLargeException
import io.ktor.server.plugins.origin
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.request.httpMethod
import io.ktor.server.request.path
import io.ktor.server.response.respond
import java.io.File
import java.net.URI
import java.security.MessageDigest
import java.nio.file.Path
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import org.slf4j.event.Level

data class AppConfig(
    val host: String,
    val port: Int,
    val jdbcUrl: String,
    val uiEnabled: Boolean,
    val adminToken: String,
    val corsOrigins: List<String>,
    /**
     * Canonical browser-facing HTTP(S) origin. Set REVIEW_PUBLIC_ORIGIN when deployed behind TLS/proxying;
     * it drives exact Origin validation and the session cookie's Secure flag. A null value uses the
     * direct request origin, which is intended only for local development.
     */
    val publicOrigin: String? = null,
    /** Directory containing immutable picture assets referenced by the SQLite database. */
    val picturePath: String = "./data/review-pictures",
) {
    companion object {
        fun fromEnvironment(environment: Map<String, String> = System.getenv()): AppConfig {
            val databasePath = environment["REVIEW_DATABASE_PATH"]?.takeIf(String::isNotBlank)
                ?: "./data/review-engine.db"
            val token = environment["REVIEW_ADMIN_TOKEN"]?.takeIf(String::isNotBlank)
                ?: throw IllegalStateException("REVIEW_ADMIN_TOKEN must be set")
            require(token.length >= 16) { "REVIEW_ADMIN_TOKEN must contain at least 16 characters" }
            val port = environment["REVIEW_HTTP_PORT"]?.toIntOrNull() ?: 8080
            require(port in 1..65535) { "REVIEW_HTTP_PORT must be a valid port" }
            return AppConfig(
                host = environment["REVIEW_HTTP_HOST"]?.takeIf(String::isNotBlank) ?: "127.0.0.1",
                port = port,
                jdbcUrl = if (databasePath.startsWith("jdbc:sqlite:")) databasePath else "jdbc:sqlite:$databasePath",
                uiEnabled = environment["REVIEW_UI_ENABLED"]?.toBooleanStrictOrNull() ?: true,
                adminToken = token,
                corsOrigins = environment["REVIEW_CORS_ORIGINS"]
                    ?.split(',')
                    ?.map(String::trim)
                    ?.filter(String::isNotEmpty)
                    .orEmpty(),
                publicOrigin = environment["REVIEW_PUBLIC_ORIGIN"]
                    ?.takeIf(String::isNotEmpty)
                    ?.let(::normalizePublicOrigin),
                picturePath = environment["REVIEW_PICTURE_PATH"]
                    ?.takeIf(String::isNotBlank)
                    ?: defaultPicturePath(databasePath),
            )
        }
    }
}

internal fun startServer() {
    val config = AppConfig.fromEnvironment()
    config.jdbcUrl.removePrefix("jdbc:sqlite:")
        .takeUnless { it.startsWith(":memory:") || it.startsWith("file:") }
        ?.let(::File)
        ?.absoluteFile
        ?.parentFile
        ?.mkdirs()
    val database = Database(config.jdbcUrl)
    database.migrate()
    val pictureStorage = PictureStorage(Path.of(config.picturePath)).also(PictureStorage::initialize)
    val engine = ReviewEngine(database, pictureStorage = pictureStorage)
    embeddedServer(Netty, host = config.host, port = config.port) {
        reviewEngineModule(engine, config)
    }.start(wait = true)
}

fun Application.reviewEngineModule(engine: ReviewEngine, config: AppConfig) {
    install(DefaultHeaders) {
        header("X-Content-Type-Options", "nosniff")
        header("Referrer-Policy", "no-referrer")
        header("X-Frame-Options", "DENY")
    }
    install(ContentNegotiation) {
        json(
            Json {
                encodeDefaults = true
                explicitNulls = false
                ignoreUnknownKeys = false
                prettyPrint = false
            },
        )
    }
    install(CallLogging) {
        level = Level.INFO
        filter { call -> call.request.path() != "/api/v1/health/live" }
        format { call ->
            "request method=${call.request.httpMethod.value} path=${call.request.path()} status=${call.response.status()?.value ?: 0}"
        }
    }
    if (config.corsOrigins.isNotEmpty()) {
        install(CORS) {
            config.corsOrigins.forEach { configured ->
                val host = configured.substringAfter("://").substringBefore('/')
                val schemes = configured.substringBefore("://", "https").let(::listOf)
                allowHost(host, schemes = schemes)
            }
            allowHeader(HttpHeaders.Authorization)
            allowHeader(HttpHeaders.ContentType)
            allowMethod(HttpMethod.Patch)
            allowMethod(HttpMethod.Delete)
        }
    }
    install(Authentication) {
        bearer("admin") {
            realm = "review-engine"
            authHeader { call ->
                call.request.headers[HttpHeaders.Authorization]
                    ?.let(::parseAuthorizationHeader)
                    ?: call.request.cookies[BROWSER_SESSION_COOKIE]
                        ?.let { HttpAuthHeader.Single("Bearer", it) }
            }
            authenticate { credential ->
                if (request.headers[HttpHeaders.Authorization] != null) {
                    when {
                        constantTimeEquals(credential.token, config.adminToken) -> UserIdPrincipal("admin")
                        engine.isStoredTokenActive(credential.token) -> UserIdPrincipal("api-token")
                        else -> null
                    }
                } else if (engine.isBrowserSessionActive(credential.token, config.adminToken)) {
                    UserIdPrincipal("browser-session")
                } else {
                    null
                }
            }
        }
    }
    install(StatusPages) {
        status(HttpStatusCode.Unauthorized) { call, status ->
            call.response.headers.append(
                HttpHeaders.WWWAuthenticate,
                "Bearer realm=\"review-engine\"",
                safeOnly = false,
            )
            call.respond(
                status,
                ErrorDto(DomainErrorCode.UNAUTHORIZED.name, "A valid bearer token or browser session is required"),
            )
        }
        exception<OriginMismatchException> { call, _ ->
            call.respond(
                HttpStatusCode.Forbidden,
                ErrorDto("ORIGIN_MISMATCH", "Cookie-authenticated unsafe requests require the configured Origin"),
            )
        }
        exception<DomainException> { call, cause ->
            call.respond(domainStatus(cause.code), ErrorDto(cause.code.name, cause.message, cause.details))
        }
        exception<PayloadTooLargeException> { call, _ ->
            call.respond(
                HttpStatusCode.PayloadTooLarge,
                ErrorDto("PAYLOAD_TOO_LARGE", "The request body exceeds the allowed size"),
            )
        }
        exception<SerializationException> { call, cause ->
            call.respond(HttpStatusCode.BadRequest, ErrorDto("INVALID_JSON", "Request JSON is invalid"))
        }
        exception<Throwable> { call, cause ->
            this@reviewEngineModule.environment.log.error("Unhandled request failure", cause)
            val invalidInput = cause::class.simpleName?.contains("ContentTransformation") == true ||
                cause is IllegalArgumentException
            if (invalidInput) {
                call.respond(HttpStatusCode.BadRequest, ErrorDto("INVALID_REQUEST", "The request could not be parsed"))
            } else {
                call.respond(HttpStatusCode.InternalServerError, ErrorDto("INTERNAL_ERROR", "The request could not be completed"))
            }
        }
    }
    configureRoutes(engine, config)
}

private fun parseAuthorizationHeader(value: String): HttpAuthHeader? {
    val separator = value.indexOf(' ')
    if (separator <= 0 || separator == value.lastIndex) return null
    val scheme = value.substring(0, separator)
    val credential = value.substring(separator + 1)
    if (scheme.any(Char::isWhitespace) || credential.any(Char::isWhitespace)) return null
    return HttpAuthHeader.Single(scheme, credential)
}

internal fun requireSameOriginForCookieWrite(call: ApplicationCall, config: AppConfig) {
    if (call.request.httpMethod in SAFE_HTTP_METHODS) return
    val suppliedOrigins = call.request.headers.getAll(HttpHeaders.Origin)
    if (suppliedOrigins?.singleOrNull() != expectedOrigin(call, config)) throw OriginMismatchException()
}

internal fun expectedOrigin(call: ApplicationCall, config: AppConfig): String = config.publicOrigin ?: run {
    val connection = call.request.origin
    canonicalOrigin(connection.scheme, connection.serverHost, connection.serverPort)
}

internal fun sessionCookieSecure(call: ApplicationCall, config: AppConfig): Boolean =
    config.publicOrigin?.startsWith("https://") ?: call.request.origin.scheme.equals("https", ignoreCase = true)

internal fun normalizePublicOrigin(value: String): String {
    val uri = try {
        URI(value)
    } catch (exception: Exception) {
        throw IllegalArgumentException("REVIEW_PUBLIC_ORIGIN must be an absolute HTTP(S) origin without a path", exception)
    }
    val scheme = uri.scheme?.lowercase()
    require(scheme == "http" || scheme == "https") {
        "REVIEW_PUBLIC_ORIGIN must use http or https"
    }
    require(
        uri.isAbsolute &&
            uri.rawAuthority != null &&
            uri.rawUserInfo == null &&
            !uri.host.isNullOrBlank() &&
            uri.rawPath.isNullOrEmpty() &&
            uri.rawQuery == null &&
            uri.rawFragment == null &&
            (uri.port == -1 || uri.port in 1..65535),
    ) { "REVIEW_PUBLIC_ORIGIN must be an absolute origin without credentials, path, query, or fragment" }
    return canonicalOrigin(scheme, uri.host, uri.port)
}

private fun canonicalOrigin(scheme: String, host: String, port: Int): String {
    val normalizedScheme = scheme.lowercase()
    val normalizedHost = host.lowercase().let { value ->
        if (':' in value && !value.startsWith('[')) "[$value]" else value
    }
    val defaultPort = (normalizedScheme == "http" && port == 80) || (normalizedScheme == "https" && port == 443)
    return "$normalizedScheme://$normalizedHost${if (port == -1 || defaultPort) "" else ":$port"}"
}

internal class OriginMismatchException : RuntimeException()

private val SAFE_HTTP_METHODS = setOf(HttpMethod.Get, HttpMethod.Head, HttpMethod.Options)

private fun constantTimeEquals(left: String, right: String): Boolean = MessageDigest.isEqual(
    left.toByteArray(Charsets.UTF_8),
    right.toByteArray(Charsets.UTF_8),
)

private fun domainStatus(code: DomainErrorCode): HttpStatusCode = when (code) {
    DomainErrorCode.NOT_FOUND -> HttpStatusCode.NotFound
    DomainErrorCode.OPTIMISTIC_LOCK_CONFLICT,
    DomainErrorCode.CONFLICT,
    DomainErrorCode.IMMUTABLE_RESOURCE,
    DomainErrorCode.INVALID_STATE_TRANSITION,
    DomainErrorCode.HIERARCHY_CYCLE,
    DomainErrorCode.PICTURE_LIMIT_EXCEEDED,
    -> HttpStatusCode.Conflict
    DomainErrorCode.UNAUTHORIZED -> HttpStatusCode.Unauthorized
    DomainErrorCode.PAYLOAD_TOO_LARGE -> HttpStatusCode.PayloadTooLarge
    DomainErrorCode.UNSUPPORTED_PICTURE_TYPE -> HttpStatusCode.UnsupportedMediaType
    else -> HttpStatusCode.UnprocessableEntity
}

private fun defaultPicturePath(databasePath: String): String {
    val path = databasePath.removePrefix("jdbc:sqlite:")
    if (path.startsWith(":memory:") || path.startsWith("file:")) return "./data/review-pictures"
    return File(path).absoluteFile.parentFile.resolve("review-pictures").path
}
