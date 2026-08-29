# ADR 0005: Cloudflare Workers, D1, and R2 for production

- Status: Accepted
- Date: 2026-08-28
- Supersedes in production: ADR 0001’s JVM stack choice and ADR 0003’s OCI deployment unit

## Context

The OCI application coupled a JVM API, SQLite database, React assets, and picture files to one host and one persistent volume. The desired deployment platform is Cloudflare, where long-running JVM processes and local durable disks are not the native execution model.

The public API, optimistic revisions, historical review semantics, portable JSON format, and same-origin browser session behavior must remain stable.

## Decision

Production uses one TypeScript Cloudflare Worker. D1 stores relational application and authorization data. R2 stores review-picture bytes. Workers Static Assets serves the built React application through the same origin as the API.

Picture files are uploaded individually as fixed-length raw request bodies. The Cloudflare edge supplies `Content-Length`, and the Worker rejects missing or oversized lengths before R2. The client carries the returned review revision into each subsequent upload. This keeps each request within Cloudflare’s 100 MB request-body limit while retaining the three-picture review limit.

Portable exports read every table in one D1 batch so they represent one relational snapshot. In-application imports use an atomic import lock and accept at most 450 rows; larger recovery operations use the D1 restore procedure. R2 deletions use a D1 outbox with immediate and scheduled retries because D1 and R2 cannot participate in one transaction.

The Kotlin/SQLite container remains as a local fallback and migration source, not as the production unit.

## Consequences

- Production no longer depends on a server, JVM, Docker runtime, or mounted SQLite volume.
- D1 migrations and R2 object keys become operational recovery contracts.
- A complete backup must include D1 and R2.
- Browser sessions are invalidated at the migration boundary; administrator credentials are provisioned as Worker secrets.
- D1’s request and batch limits constrain in-application portable imports to 450 rows, more tightly than the former local process.
- The Worker API must be tested in the Cloudflare runtime, in addition to frontend tests.
