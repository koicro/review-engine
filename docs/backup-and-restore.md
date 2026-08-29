# Backup and restore

Production data spans D1 and R2. A complete recovery point must preserve both services together: D1 contains picture metadata and R2 contains the corresponding bytes.

Take both captures inside one maintenance window. Temporarily deny application traffic at the Cloudflare edge (for example, disable the `workers.dev` route or apply a temporary Access/WAF rule), wait for in-flight requests to finish, and keep writes blocked until the D1 export and R2 mirror have both completed. Without that freeze, a restored database can reference an R2 object captured before or after its matching metadata.

## Portable application export

The UI and `POST /api/v1/exports` produce Review Engine JSON format 1.1 from one atomic D1 snapshot. It includes categories, templates, entities, review history, scores, and relations. In-application imports accept versions 1.0 and 1.1, contain at most 450 rows, and must target an empty application database; use the D1 restore procedure for larger datasets.

Portable JSON intentionally excludes access credentials, browser sessions, picture metadata, and R2 objects. Use it to move structured review data, not as the only disaster-recovery backup.

## D1 backup

Export the production database to a protected, timestamped directory:

```sh
backup_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "backups/$backup_stamp"
npx wrangler d1 export review-engine-db --remote --output "backups/$backup_stamp/review-engine-d1.sql"
```

`wrangler d1 export` temporarily blocks other requests to that database. Schedule and announce this interruption; readiness and protected routes can fail until the export finishes. Keep application traffic blocked while the corresponding R2 capture is taken.

Record the export time and retain the SQL file off-host. Before relying on it, import it into a separate D1 database and compare table counts plus `PRAGMA foreign_key_check`.

## R2 backup

Mirror the complete `review-engine-pictures` bucket into the same timestamped recovery-point directory with an S3-compatible backup tool using a narrowly scoped R2 API token. Preserve object keys exactly and save an object-key/size manifest beside the mirror. Encrypt the backup destination and keep its credentials separate from Worker secrets.

No picture objects existed at the initial Cloudflare cutover, but future backups must still include R2 once attachments are added.

Before reopening traffic, record D1 table counts, compare the `picture_asset.storage_key` values with the R2 manifest, and confirm `/api/v1/health/ready` returns `200`. Only then remove the temporary traffic restriction.

## Restore

The safest restore uses new resources:

1. Create a new D1 database and R2 bucket.
2. Import the D1 SQL export.
3. Restore every R2 object under its original key.
4. Verify D1 foreign keys, table counts, and R2 object counts.
5. Deploy a temporary Worker bound to the restored resources.
6. Verify categories, entities, hidden and superseded review history, comparisons, relations, and representative picture downloads.
7. Switch production bindings only after validation.

Browser sessions should be invalidated across a restore boundary. Administrator credentials belong in the destination Worker’s secret store and should be rotated rather than copied from a source file.

## Legacy SQLite volume

During the migration period, retain the stopped Docker volume as a rollback source. A consistent legacy backup requires stopping the container and archiving the entire volume, including SQLite sidecars and `review-pictures/`. Never use `docker compose down --volumes` in a normal backup or rollback procedure.

## Retention

Keep the last known-good pre-upgrade backup, several recent daily recovery points, and periodic off-account copies appropriate to the data’s importance. Test restoration regularly; an untested backup is only an assumption.
