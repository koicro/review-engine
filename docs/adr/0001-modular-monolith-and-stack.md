# ADR 0001: Modular monolith and reference stack

- Status: Accepted
- Date: 2026-08-13

## Context

The domain has strict invariants across categories, template versions, reviews, scores, and relations. The initial product must remain simple to self-host and must not depend on external services.

## Decision

Build a modular monolith with a Kotlin/JVM 21 and Ktor API, SQLite persistence, and a TypeScript/React reference UI. Keep framework types out of the domain model and separate domain, application, API, persistence, and web responsibilities. The UI uses the same public REST API available to custom clients.

## Consequences

Transactions that span domain concepts remain local and straightforward. Operators deploy one application process and one data file. Module boundaries must be enforced through package and dependency discipline rather than network boundaries. PostgreSQL and service decomposition remain possible future work but are not compatibility promises for the MVP.
