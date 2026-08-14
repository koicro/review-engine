package dev.reviewengine.api

import io.ktor.http.ContentType
import io.ktor.server.application.ApplicationCall
import io.ktor.server.response.respondText

internal suspend fun ApplicationCall.respondOpenApi() = respondText(OPEN_API_JSON, ContentType.Application.Json)

private val OPEN_API_JSON: String by lazy {
    OpenApiResourceMarker::class.java.getResource("/openapi.json")?.readText()
        ?: error("Missing OpenAPI resource /openapi.json")
}

private object OpenApiResourceMarker
