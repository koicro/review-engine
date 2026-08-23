package dev.reviewengine.api

import dev.reviewengine.application.Aggregation
import dev.reviewengine.application.ComparisonQuery
import dev.reviewengine.application.DEFAULT_REVIEWER_ID
import dev.reviewengine.application.RelationDirection
import dev.reviewengine.application.compare
import dev.reviewengine.application.createCategory
import dev.reviewengine.application.createEntity
import dev.reviewengine.application.createRelation
import dev.reviewengine.application.createRelationType
import dev.reviewengine.application.createReview
import dev.reviewengine.application.createTemplateDraft
import dev.reviewengine.application.deleteCategory
import dev.reviewengine.application.deleteDraftReview
import dev.reviewengine.application.deleteEntity
import dev.reviewengine.application.deleteRelation
import dev.reviewengine.application.exportJson
import dev.reviewengine.application.finalizeReview
import dev.reviewengine.application.getCategory
import dev.reviewengine.application.getEntity
import dev.reviewengine.application.getReview
import dev.reviewengine.application.getTemplateVersion
import dev.reviewengine.application.importJson
import dev.reviewengine.application.issueAccessToken
import dev.reviewengine.application.issueBrowserSession
import dev.reviewengine.application.listAccessTokens
import dev.reviewengine.application.listCategories
import dev.reviewengine.application.listEntities
import dev.reviewengine.application.listRelationTypes
import dev.reviewengine.application.listRelations
import dev.reviewengine.application.listReviews
import dev.reviewengine.application.listTemplateVersions
import dev.reviewengine.application.publishTemplate
import dev.reviewengine.application.relatedEntities
import dev.reviewengine.application.reviseReview
import dev.reviewengine.application.revokeAccessToken
import dev.reviewengine.application.revokeBrowserSession
import dev.reviewengine.application.updateCategory
import dev.reviewengine.application.updateEntity
import dev.reviewengine.application.updateReview
import dev.reviewengine.application.updateReviewVisibility
import dev.reviewengine.application.updateTemplateDraft
import dev.reviewengine.application.validateImport
import dev.reviewengine.application.ReviewEngine
import dev.reviewengine.domain.DomainErrorCode
import dev.reviewengine.domain.DomainException
import io.ktor.http.ContentDisposition
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.Application
import io.ktor.server.application.ApplicationCallPipeline
import io.ktor.server.application.call
import io.ktor.server.auth.authenticate
import io.ktor.server.plugins.bodylimit.RequestBodyLimit
import io.ktor.server.http.content.staticResources
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.response.header
import io.ktor.server.response.respondText
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.patch
import io.ktor.server.routing.post
import io.ktor.server.routing.route
import io.ktor.server.routing.routing
import java.time.Instant
import java.time.Duration
import java.util.UUID
import kotlinx.serialization.json.JsonElement

internal fun Application.configureRoutes(engine: ReviewEngine, config: AppConfig) {
    routing {
        get("/openapi.json") { call.respondOpenApi() }
        route("/api/v1") {
            get("/health/live") { call.respond(HealthDto("live")) }
            get("/health/ready") {
                if (engine.ready()) call.respond(HealthDto("ready"))
                else call.respond(HttpStatusCode.ServiceUnavailable, HealthDto("not-ready"))
            }
            get("/openapi.json") { call.respondOpenApi() }

            route("/session") {
                install(RequestBodyLimit) {
                    bodyLimit { SESSION_REQUEST_BODY_LIMIT_BYTES }
                }
                post {
                    requireSameOriginForCookieWrite(call, config)
                    val credential = call.receive<SessionCreateDto>().token
                    if (credential.isBlank() || credential.length > SESSION_CREDENTIAL_MAX_CHARS) {
                        throw DomainException(DomainErrorCode.UNAUTHORIZED, SESSION_AUTHENTICATION_FAILURE)
                    }
                    val session = engine.issueBrowserSession(
                        credential,
                        config.adminToken,
                        BROWSER_SESSION_LIFETIME,
                    )
                    call.response.cookies.append(
                        name = BROWSER_SESSION_COOKIE,
                        value = session.rawId,
                        maxAge = BROWSER_SESSION_MAX_AGE_SECONDS,
                        path = BROWSER_SESSION_COOKIE_PATH,
                        secure = sessionCookieSecure(call, config),
                        httpOnly = true,
                        extensions = mapOf("SameSite" to "Strict"),
                    )
                    call.response.header(HttpHeaders.CacheControl, "no-store")
                    call.respond(HttpStatusCode.NoContent)
                }
                delete {
                    call.request.cookies[BROWSER_SESSION_COOKIE]?.let { rawId ->
                        requireSameOriginForCookieWrite(call, config)
                        engine.revokeBrowserSession(rawId)
                    }
                    call.response.cookies.append(
                        name = BROWSER_SESSION_COOKIE,
                        value = "",
                        maxAge = 0,
                        path = BROWSER_SESSION_COOKIE_PATH,
                        secure = sessionCookieSecure(call, config),
                        httpOnly = true,
                        extensions = mapOf("SameSite" to "Strict"),
                    )
                    call.response.header(HttpHeaders.CacheControl, "no-store")
                    call.respond(HttpStatusCode.NoContent)
                }
            }

            authenticate("admin") {
                // Keep CSRF rejection outside Authentication so Ktor cannot turn it into a 401 challenge.
                intercept(ApplicationCallPipeline.Call) {
                    if (
                        call.request.headers[HttpHeaders.Authorization] == null &&
                        call.request.cookies[BROWSER_SESSION_COOKIE] != null
                    ) {
                        requireSameOriginForCookieWrite(call, config)
                    }
                }
                route("/categories") {
                    get {
                        call.respond(
                            engine.listCategories(
                                cursor = call.request.queryParameters["cursor"],
                                includeArchived = call.booleanQuery("includeArchived", false),
                                limit = call.intQuery("limit"),
                            ).dto { it.dto() },
                        )
                    }
                    post {
                        val body = call.receive<CategoryCreateDto>()
                        call.respond(HttpStatusCode.Created, engine.createCategory(body.name, body.description).dto())
                    }
                    route("/{categoryId}") {
                        get { call.respond(engine.getCategory(call.pathUuid("categoryId")).dto()) }
                        patch {
                            val body = call.receive<CategoryPatchDto>()
                            call.respond(engine.updateCategory(call.pathUuid("categoryId"), body.input()).dto())
                        }
                        delete {
                            engine.deleteCategory(call.pathUuid("categoryId"))
                            call.respond(HttpStatusCode.NoContent)
                        }
                        route("/template-versions") {
                            get {
                                call.respond(PageDto(engine.listTemplateVersions(call.pathUuid("categoryId")).map { it.dto() }))
                            }
                            post {
                                val body = call.receive<TemplateDraftCreateDto>()
                                call.respond(
                                    HttpStatusCode.Created,
                                    engine.createTemplateDraft(call.pathUuid("categoryId"), body.criteria?.map { it.input() }).dto(),
                                )
                            }
                        }
                    }
                }

                route("/template-versions/{versionId}") {
                    get { call.respond(engine.getTemplateVersion(call.pathUuid("versionId")).dto()) }
                    patch {
                        val body = call.receive<TemplatePatchDto>()
                        call.respond(
                            engine.updateTemplateDraft(call.pathUuid("versionId"), body.criteria.map { it.input() }, body.revision).dto(),
                        )
                    }
                    post("/publish") {
                        val body = call.receive<RevisionDto>()
                        call.respond(engine.publishTemplate(call.pathUuid("versionId"), body.revision).dto())
                    }
                }

                route("/entities") {
                    get {
                        call.respond(
                            engine.listEntities(
                                categoryId = call.request.queryParameters["categoryId"]?.let(::uuid),
                                query = call.request.queryParameters["query"],
                                includeArchived = call.booleanQuery("includeArchived", false),
                                cursor = call.request.queryParameters["cursor"],
                                limit = call.intQuery("limit"),
                            ).dto { it.dto() },
                        )
                    }
                    post {
                        val body = call.receive<EntityCreateDto>()
                        call.respond(HttpStatusCode.Created, engine.createEntity(uuid(body.categoryId), body.name, body.description).dto())
                    }
                    route("/{entityId}") {
                        get { call.respond(engine.getEntity(call.pathUuid("entityId")).dto()) }
                        patch {
                            val body = call.receive<EntityPatchDto>()
                            call.respond(engine.updateEntity(call.pathUuid("entityId"), body.input()).dto())
                        }
                        delete {
                            engine.deleteEntity(call.pathUuid("entityId"))
                            call.respond(HttpStatusCode.NoContent)
                        }
                        route("/reviews") {
                            get {
                                call.respond(
                                    engine.listReviews(
                                        call.pathUuid("entityId"),
                                        includeSuperseded = call.booleanQuery("includeSuperseded", false),
                                        includeHidden = call.booleanQuery("includeHidden", false),
                                        cursor = call.request.queryParameters["cursor"],
                                        limit = call.intQuery("limit"),
                                    ).dto { it.dto() },
                                )
                            }
                            post {
                                val body = call.receive<ReviewWriteDto>()
                                call.respond(
                                    HttpStatusCode.Created,
                                    engine.createReview(call.pathUuid("entityId"), body.input(UUID.fromString(DEFAULT_REVIEWER_ID))).dto(),
                                )
                            }
                        }
                        get("/related") {
                            val direction = call.request.queryParameters["direction"]?.let { value ->
                                enumValue<RelationDirection>(value)
                            } ?: RelationDirection.BOTH
                            call.respond(
                                PageDto(
                                    engine.relatedEntities(
                                        call.pathUuid("entityId"),
                                        call.request.queryParameters["relationTypeId"]?.let(::uuid),
                                        direction,
                                        call.intQuery("maxDepth") ?: 1,
                                    ).map { it.dto() },
                                ),
                            )
                        }
                    }
                }

                route("/reviews/{reviewId}") {
                    get { call.respond(engine.getReview(call.pathUuid("reviewId")).dto()) }
                    patch {
                        val body = call.receive<ReviewWriteDto>()
                        call.respond(engine.updateReview(call.pathUuid("reviewId"), body.input(UUID.fromString(DEFAULT_REVIEWER_ID))).dto())
                    }
                    delete {
                        engine.deleteDraftReview(call.pathUuid("reviewId"), call.requiredQueryLong("revision"))
                        call.respond(HttpStatusCode.NoContent)
                    }
                    post("/finalize") {
                        val body = call.receive<FinalizeReviewDto>()
                        call.respond(
                            engine.finalizeReview(
                                call.pathUuid("reviewId"),
                                body.revision,
                                body.scores?.map { dev.reviewengine.application.ScoreInput(uuid(it.criterionId), it.tickIndex) },
                            ).dto(),
                        )
                    }
                    post("/revisions") {
                        val body = call.receive<ReviewWriteDto>()
                        call.respond(
                            HttpStatusCode.Created,
                            engine.reviseReview(call.pathUuid("reviewId"), body.input(UUID.fromString(DEFAULT_REVIEWER_ID))).dto(),
                        )
                    }
                    patch("/visibility") {
                        val body = call.receive<ReviewVisibilityDto>()
                        call.respond(engine.updateReviewVisibility(call.pathUuid("reviewId"), body.input()).dto())
                    }
                }

                get("/comparisons") {
                    val query = ComparisonQuery(
                        categoryId = call.requiredQueryUuid("categoryId"),
                        entityIds = call.request.queryParameters.getAll("entityId").orEmpty().map(::uuid),
                        aggregation = call.request.queryParameters["aggregation"]?.let { enumValue<Aggregation>(it) }
                            ?: Aggregation.LATEST,
                        from = call.request.queryParameters["from"]?.let(::instant),
                        to = call.request.queryParameters["to"]?.let(::instant),
                        reviewerId = call.request.queryParameters["reviewerId"]?.let(::uuid),
                    )
                    if (query.from != null && query.to != null && query.from > query.to) {
                        invalidArgument("from must be earlier than or equal to to")
                    }
                    call.respond(engine.compare(query).dto())
                }

                route("/relation-types") {
                    get { call.respond(PageDto(engine.listRelationTypes().map { it.dto() })) }
                    post {
                        val body = call.receive<RelationTypeCreateDto>()
                        call.respond(
                            HttpStatusCode.Created,
                            engine.createRelationType(body.key, body.forwardLabel, body.inverseLabel, body.hierarchical).dto(),
                        )
                    }
                }

                route("/relations") {
                    get {
                        call.respond(
                            engine.listRelations(
                                entityId = call.request.queryParameters["entityId"]?.let(::uuid),
                                relationTypeId = call.request.queryParameters["relationTypeId"]?.let(::uuid),
                                cursor = call.request.queryParameters["cursor"],
                                limit = call.intQuery("limit"),
                            ).dto { it.dto() },
                        )
                    }
                    post {
                        val body = call.receive<RelationCreateDto>()
                        call.respond(
                            HttpStatusCode.Created,
                            engine.createRelation(uuid(body.sourceEntityId), uuid(body.targetEntityId), uuid(body.relationTypeId)).dto(),
                        )
                    }
                    delete("/{relationId}") {
                        engine.deleteRelation(call.pathUuid("relationId"))
                        call.respond(HttpStatusCode.NoContent)
                    }
                }

                post("/exports") {
                    call.response.header(
                        HttpHeaders.ContentDisposition,
                        ContentDisposition.Attachment.withParameter(
                            ContentDisposition.Parameters.FileName,
                            "review-engine-${Instant.now()}.json",
                        ).toString(),
                    )
                    call.respondText(engine.exportJson().toString(), ContentType.Application.Json)
                }
                route("/imports") {
                    install(RequestBodyLimit) {
                        bodyLimit { IMPORT_BODY_LIMIT_BYTES }
                    }
                    post("/validate") {
                        val validation = engine.validateImport(call.receive<JsonElement>())
                        call.respond(
                            ImportValidationDto(
                                validation.valid,
                                validation.errors.map { ImportIssueDto(it.path, it.code, it.message) },
                                validation.counts,
                                validation.formatVersion,
                            ),
                        )
                    }
                    post {
                        val counts = engine.importJson(call.receive<JsonElement>())
                        call.respond(ImportResultDto(true, counts))
                    }
                }

                route("/access-tokens") {
                    get {
                        call.respond(
                            PageDto(
                                engine.listAccessTokens().map { TokenDto(it.id.toString(), it.name, it.createdAt.toString(), it.revokedAt?.toString()) },
                            ),
                        )
                    }
                    post {
                        val issued = engine.issueAccessToken(call.receive<TokenCreateDto>().name)
                        call.respond(
                            HttpStatusCode.Created,
                            IssuedTokenDto(
                                TokenDto(issued.record.id.toString(), issued.record.name, issued.record.createdAt.toString()),
                                issued.token,
                            ),
                        )
                    }
                    post("/{tokenId}/revoke") {
                        val token = engine.revokeAccessToken(call.pathUuid("tokenId"))
                        call.respond(TokenDto(token.id.toString(), token.name, token.createdAt.toString(), token.revokedAt?.toString()))
                    }
                }
            }
        }
        if (config.uiEnabled) staticResources("/", "web", index = "index.html")
    }
}

private fun io.ktor.server.application.ApplicationCall.pathUuid(name: String): UUID = parameters[name]?.let(::uuid)
    ?: invalidArgument("Missing path parameter $name")

private fun io.ktor.server.application.ApplicationCall.requiredQueryUuid(name: String): UUID =
    request.queryParameters[name]?.let(::uuid) ?: invalidArgument("Missing query parameter $name")

private fun io.ktor.server.application.ApplicationCall.requiredQueryLong(name: String): Long =
    request.queryParameters[name]?.toLongOrNull() ?: invalidArgument("Missing or invalid query parameter $name")

private fun io.ktor.server.application.ApplicationCall.booleanQuery(name: String, default: Boolean): Boolean {
    val raw = request.queryParameters[name] ?: return default
    return raw.toBooleanStrictOrNull() ?: invalidArgument("$name must be true or false")
}

private fun io.ktor.server.application.ApplicationCall.intQuery(name: String): Int? {
    val raw = request.queryParameters[name] ?: return null
    return raw.toIntOrNull() ?: invalidArgument("$name must be an integer")
}

private inline fun <reified T : Enum<T>> enumValue(raw: String): T = enumValues<T>()
    .firstOrNull { it.name.equals(raw, ignoreCase = true) }
    ?: invalidArgument("Unsupported value '$raw'")

private fun invalidArgument(message: String): Nothing = throw DomainException(DomainErrorCode.INVALID_ARGUMENT, message)

private const val IMPORT_BODY_LIMIT_BYTES: Long = 256L * 1024L * 1024L
private const val SESSION_REQUEST_BODY_LIMIT_BYTES: Long = 8L * 1024L
private const val SESSION_CREDENTIAL_MAX_CHARS: Int = 512
private const val SESSION_AUTHENTICATION_FAILURE: String = "The supplied credential is not active"
internal const val BROWSER_SESSION_COOKIE: String = "review_engine_session"
private const val BROWSER_SESSION_COOKIE_PATH: String = "/api/v1"
private const val BROWSER_SESSION_MAX_AGE_SECONDS: Long = 12L * 60L * 60L
private val BROWSER_SESSION_LIFETIME: Duration = Duration.ofSeconds(BROWSER_SESSION_MAX_AGE_SECONDS)
