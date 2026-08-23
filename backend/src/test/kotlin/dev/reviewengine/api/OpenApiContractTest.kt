package dev.reviewengine.api

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class OpenApiContractTest {
    private val document: JsonObject = Json.parseToJsonElement(
        requireNotNull(javaClass.getResource("/openapi.json")) { "Missing /openapi.json" }.readText(),
    ).jsonObject

    @Test
    fun documentCoversEveryImplementedOperationWithStableResponses() {
        assertEquals("3.1.0", document.getValue("openapi").jsonPrimitive.content)
        val operations = operations()
        assertEquals(expectedOperations, operations.keys)

        operations.forEach { (key, operation) ->
            assertTrue(operation["operationId"]?.jsonPrimitive?.content?.isNotBlank() == true, "$key has no operationId")
            val responses = operation.getValue("responses").jsonObject
            val success = responses.entries.singleOrNull { (status) -> status.startsWith("2") }
            assertNotNull(success, "$key must declare exactly one success response")
            if (success.key != "204") {
                val content = resolve(success.value).jsonObject["content"]?.jsonObject
                val schema = content?.get("application/json")?.jsonObject?.get("schema")
                assertNotNull(schema, "$key success response has no application/json schema")
            }
            val defaultResponse = responses["default"]
            assertNotNull(defaultResponse, "$key has no stable default error response")
            assertEquals(
                "#/components/schemas/Error",
                resolve(defaultResponse).jsonObject
                    .getValue("content").jsonObject
                    .getValue("application/json").jsonObject
                    .getValue("schema").jsonObject
                    .getValue(REF_KEY).jsonPrimitive.content,
                "$key default response does not use ErrorDto",
            )
            val public = operation["security"] == JsonArray(emptyList())
            if (!public) {
                assertNotNull(responses["401"], "$key has no authentication-error response")
            }
        }
    }

    @Test
    fun pathAndQueryParametersMatchRoutingContract() {
        operations().forEach { (key, operation) ->
            val path = key.substringAfter(' ')
            val pathItem = document.getValue("paths").jsonObject.getValue(path).jsonObject
            val parameters = (
                pathItem["parameters"].asArray() +
                    operation["parameters"].asArray()
                ).map(::resolve).map(JsonElement::jsonObject)

            val declaredPathParameters = parameters
                .filter { it.getValue("in").jsonPrimitive.content == "path" }
                .mapTo(mutableSetOf()) { it.getValue("name").jsonPrimitive.content }
            val templatedPathParameters = path.split('{').drop(1)
                .mapTo(mutableSetOf()) { it.substringBefore('}') }
            assertEquals(templatedPathParameters, declaredPathParameters, "$key path parameters differ")
            parameters.filter { it.getValue("in").jsonPrimitive.content == "path" }.forEach {
                assertEquals("true", it.getValue("required").jsonPrimitive.content, "$key path parameter is optional")
            }

            val queryParameters = parameters
                .filter { it.getValue("in").jsonPrimitive.content == "query" }
                .mapTo(mutableSetOf()) { it.getValue("name").jsonPrimitive.content }
            assertEquals(expectedQueryParameters[key].orEmpty(), queryParameters, "$key query parameters differ")
        }
    }

    @Test
    fun bodyBearingOperationsDeclareRequiredJsonBodiesAndAllReferencesResolve() {
        operations().forEach { (key, operation) ->
            val requestBody = operation["requestBody"]
            assertEquals(key in bodyBearingOperations, requestBody != null, "$key request-body declaration differs")
            if (requestBody != null) {
                val resolved = resolve(requestBody).jsonObject
                assertEquals("true", resolved.getValue("required").jsonPrimitive.content, "$key body must be required")
                assertNotNull(
                    resolved.getValue("content").jsonObject["application/json"]?.jsonObject?.get("schema"),
                    "$key has no JSON request schema",
                )
            }
        }
        visit(document) { reference ->
            assertNotNull(resolveReference(reference), "Unresolved local OpenAPI reference $reference")
        }
    }

    @Test
    fun portableContractDocumentsCurrentExportsAndCompatibleImports() {
        val versions = document.getValue("components").jsonObject
            .getValue("schemas").jsonObject
            .getValue("PortableDocument").jsonObject
            .getValue("properties").jsonObject
            .getValue("formatVersion").jsonObject
            .getValue("enum").asArray()
            .mapTo(mutableSetOf()) { it.jsonPrimitive.content }
        assertEquals(setOf("1.0", "1.1"), versions)
    }

    private fun operations(): Map<String, JsonObject> = buildMap {
        document.getValue("paths").jsonObject.forEach { (path, pathValue) ->
            pathValue.jsonObject.forEach { (method, operation) ->
                if (method in HTTP_METHODS) put(method.uppercase() + " " + path, operation.jsonObject)
            }
        }
    }

    private fun resolve(element: JsonElement): JsonElement {
        val reference = (element as? JsonObject)?.get(REF_KEY)?.jsonPrimitive?.content ?: return element
        return requireNotNull(resolveReference(reference)) { "Unresolved local OpenAPI reference $reference" }
    }

    private fun resolveReference(reference: String): JsonElement? {
        if (!reference.startsWith("#/")) return null
        return reference.removePrefix("#/").split('/').fold(document as JsonElement?) { current, token ->
            (current as? JsonObject)?.get(token.replace("~1", "/").replace("~0", "~"))
        }
    }

    private fun visit(element: JsonElement, onReference: (String) -> Unit) {
        when (element) {
            is JsonObject -> {
                element[REF_KEY]?.jsonPrimitive?.content?.let(onReference)
                element.values.forEach { visit(it, onReference) }
            }
            is JsonArray -> element.forEach { visit(it, onReference) }
            else -> Unit
        }
    }

    private fun JsonElement?.asArray(): List<JsonElement> = (this as? JsonArray).orEmpty()

    private companion object {
        val REF_KEY = 36.toChar().toString() + "ref"
        val HTTP_METHODS = setOf("get", "post", "patch", "delete")

        val expectedOperations = setOf(
            "GET /health/live",
            "GET /health/ready",
            "GET /openapi.json",
            "POST /session",
            "DELETE /session",
            "GET /categories",
            "POST /categories",
            "GET /categories/{categoryId}",
            "PATCH /categories/{categoryId}",
            "DELETE /categories/{categoryId}",
            "GET /categories/{categoryId}/template-versions",
            "POST /categories/{categoryId}/template-versions",
            "GET /template-versions/{versionId}",
            "PATCH /template-versions/{versionId}",
            "POST /template-versions/{versionId}/publish",
            "GET /entities",
            "POST /entities",
            "GET /entities/{entityId}",
            "PATCH /entities/{entityId}",
            "DELETE /entities/{entityId}",
            "GET /entities/{entityId}/reviews",
            "POST /entities/{entityId}/reviews",
            "GET /entities/{entityId}/related",
            "GET /reviews/{reviewId}",
            "PATCH /reviews/{reviewId}",
            "DELETE /reviews/{reviewId}",
            "POST /reviews/{reviewId}/finalize",
            "POST /reviews/{reviewId}/revisions",
            "PATCH /reviews/{reviewId}/visibility",
            "GET /comparisons",
            "GET /relation-types",
            "POST /relation-types",
            "GET /relations",
            "POST /relations",
            "DELETE /relations/{relationId}",
            "POST /exports",
            "POST /imports/validate",
            "POST /imports",
            "GET /access-tokens",
            "POST /access-tokens",
            "POST /access-tokens/{tokenId}/revoke",
        )

        val expectedQueryParameters = mapOf(
            "GET /categories" to setOf("cursor", "includeArchived", "limit"),
            "GET /entities" to setOf("categoryId", "query", "includeArchived", "cursor", "limit"),
            "GET /entities/{entityId}/reviews" to setOf("includeSuperseded", "includeHidden", "cursor", "limit"),
            "GET /entities/{entityId}/related" to setOf("relationTypeId", "direction", "maxDepth"),
            "DELETE /reviews/{reviewId}" to setOf("revision"),
            "GET /comparisons" to setOf("categoryId", "entityId", "aggregation", "from", "to", "reviewerId"),
            "GET /relations" to setOf("entityId", "relationTypeId", "cursor", "limit"),
        )

        val bodyBearingOperations = setOf(
            "POST /session",
            "POST /categories",
            "PATCH /categories/{categoryId}",
            "POST /categories/{categoryId}/template-versions",
            "PATCH /template-versions/{versionId}",
            "POST /template-versions/{versionId}/publish",
            "POST /entities",
            "PATCH /entities/{entityId}",
            "POST /entities/{entityId}/reviews",
            "PATCH /reviews/{reviewId}",
            "POST /reviews/{reviewId}/finalize",
            "POST /reviews/{reviewId}/revisions",
            "PATCH /reviews/{reviewId}/visibility",
            "POST /relation-types",
            "POST /relations",
            "POST /imports/validate",
            "POST /imports",
            "POST /access-tokens",
        )
    }
}
