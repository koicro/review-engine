# Deployment

The supported deployment unit is the OCI image. It contains the API, database migrations, reference UI, and JVM runtime, and runs as the non-root user `10001:10001`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `REVIEW_HTTP_HOST` | `0.0.0.0` | Interface bound inside the container |
| `REVIEW_HTTP_PORT` | `8080` | Port bound inside the container |
| `REVIEW_DATABASE_PATH` | `/data/review-engine.db` | SQLite database path |
| `REVIEW_UI_ENABLED` | `true` | Set to `false` for the headless API configuration |
| `REVIEW_ADMIN_TOKEN` | none in the image | Token used for administrative and write operations |
| `REVIEW_PUBLIC_ORIGIN` | direct request origin | Browser-facing HTTP(S) origin, without a path; required behind TLS or a reverse proxy |

The Compose file requires an explicit administrator token and binds the published port to localhost by default. Copy `.env.example` to `.env`, replace its placeholder, and keep that file out of version control. Pass secrets through the platform's secret manager where one is available.

## Persistent storage

Mount a persistent volume at `/data`. The application container otherwise runs with a read-only root filesystem and only needs a small writable `/tmp`. That temporary filesystem must permit executable mappings because `sqlite-jdbc` extracts its ephemeral, architecture-specific JNI library there. The supplied Compose configuration keeps the mount size-bounded with `nosuid` and `nodev` while allowing that mapping. The process writes structured logs to standard output.

SQLite works best when `/data` is backed by a local filesystem. Avoid network filesystems whose locking semantics are not explicitly compatible with SQLite. Run one application replica against a database file.

## Browser sessions and reverse proxy

The reference UI exchanges the administrator token once for a 12-hour opaque browser session. Only a hash of the session ID is stored. Its cookie is `HttpOnly`, `SameSite=Strict`, scoped to `/api/v1`, and marked `Secure` whenever `REVIEW_PUBLIC_ORIGIN` uses HTTPS. Unsafe cookie-authenticated requests must carry that exact origin. Explicit bearer tokens remain available for API clients.

Terminate TLS at a trusted reverse proxy, preserve the request host, and set `REVIEW_PUBLIC_ORIGIN` to the exact browser-facing origin, for example `https://reviews.example.com`. The MVP does not trust identity headers from a proxy. Public read-only access is not implemented, so keep the service private.

## Health checks

- `/api/v1/health/live` reports whether the process can serve requests.
- `/api/v1/health/ready` becomes successful after initialization and migrations complete and the database is usable.

Readiness should control traffic. Liveness should only restart an unresponsive process; it should not depend on optional external systems.

## Upgrades

Until the first declared schema baseline is released, development database files are not covered by an upgrade-compatibility guarantee. If you have persisted data from an earlier development snapshot, create and validate a JSON export with that build, then restore it into a fresh database with the current build. Do not assume that an edited pre-release `V001` migration will be reapplied to a database that already recorded migration 1.

1. Read the release notes and migration notes.
2. Create and verify a backup.
3. Pull the new image by immutable version tag.
4. Stop the old container cleanly.
5. Start the new image with the same `/data` volume and configuration.
6. Wait for readiness, then verify representative reads and writes.

Do not downgrade a database after a migration unless that release explicitly documents a safe downgrade path. Roll back by restoring the pre-upgrade backup into a fresh volume.

## Multi-architecture releases

Pushing a `v*` Git tag runs the release workflow and publishes `linux/amd64` and `linux/arm64` manifests to GitHub Container Registry. Release tags should be immutable and follow semantic versioning.
