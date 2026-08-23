# Backup and restore

Development database snapshots created before the first declared schema baseline have no upgrade-compatibility guarantee. Use the producing build to create and validate a JSON export, then restore into a fresh database with the current build.

Review data belongs to the operator. Keep backups outside the host that runs the application and periodically test restoration into a separate environment.

## Online export

Use the versioned JSON export through the UI or `POST /api/v1/exports` when the application is running. JSON is the portable backup format for moving data between Review Engine installations. Validate an import with `POST /api/v1/imports/validate` before writing it with `POST /api/v1/imports`.

Current exports use format version 1.1 and preserve hidden review-history state. The importer also accepts version 1.0 exports; reviews without the 1.1 `hidden_at` field are restored as visible.

An export is not a substitute for a database backup before a schema upgrade.

## Consistent SQLite backup

The simplest reliable procedure is to stop the application and archive the complete volume. Copy the database and any `-wal` or `-shm` sidecars together.

```sh
mkdir -p backups
docker compose stop review-engine
docker run --rm \
  --volume review-engine_review-engine-data:/source:ro \
  --volume "$PWD/backups:/backup" \
  alpine:3.22 \
  tar -czf "/backup/review-engine-$(date -u +%Y%m%dT%H%M%SZ).tgz" -C /source .
docker compose start review-engine
```

The Compose project or volume name may differ. Confirm the actual name with `docker volume ls` before running the command. Verify that the archive is non-empty and can be listed with `tar -tzf`.

## Restore

Restoring replaces the current database. Preserve a backup of the current volume first and restore only into a stopped application.

For the safest recovery, create a new named volume, extract the archive into it, and point a temporary deployment at that volume. Start the application, wait for readiness, and verify categories, entities, review history, relations, and a comparison before switching traffic.

Never use `docker compose down --volumes` as part of a normal backup or upgrade procedure.

## Retention

Keep at least:

- the last known-good pre-upgrade backup;
- several recent daily backups; and
- periodic off-host backups appropriate to the importance of the data.

Encrypt backups that contain private review data and restrict access to the same principals that can administer the live service.
