# Cloudflare deployment

The supported production runtime is one Cloudflare Worker with three bindings:

| Binding | Resource | Purpose |
| --- | --- | --- |
| `DB` | D1 database | Relational application and authorization data |
| `PICTURES` | R2 bucket | Review-picture bytes |
| `ASSETS` | Workers Static Assets | Built React application |

`wrangler.jsonc` is the deployment source of truth. It enables observability, routes `/api/*` through the Worker, and falls back to `index.html` for client-side navigation.

## First deployment

1. Install dependencies with `npm ci` and `npm --prefix web ci`.
2. Authenticate with `npx wrangler login`.
3. Create the D1 database and R2 bucket if they do not exist.
4. Put the resulting D1 identifier and resource names in `wrangler.jsonc`.
5. Apply the schema with `npx wrangler d1 migrations apply review-engine-db --remote`.
6. Deploy with `npm run deploy`.
7. Store a random, production-only administrator credential of at least 32 characters with `npx wrangler secret put REVIEW_ADMIN_TOKEN`.
8. Verify `/api/v1/health/ready`, sign in, and exercise a representative protected read and write.

Never place administrator credentials, API tokens, or R2 credentials in committed files. Browser sessions are 12-hour opaque cookies whose fingerprints are stored in D1. Cookies are `HttpOnly`, `Secure`, `SameSite=Strict`, and scoped to `/api/v1`; unsafe cookie-authenticated requests must carry the deployment’s exact request origin.

## Local development

Copy `.dev.vars.example` to `.dev.vars`, choose a local administrator credential, and run:

```sh
npx wrangler d1 migrations apply review-engine-db --local
npm run dev
```

Local D1 and R2 state lives under Wrangler’s ignored working directory. The production identifiers in `wrangler.jsonc` are not contacted unless `--remote` is explicitly supplied.

## Health and observability

- `/api/v1/health/live` confirms the Worker can execute.
- `/api/v1/health/ready` confirms the administrator credential is configured and D1 can answer a query.
- API responses include an `X-Request-Id`.
- Structured completion and failure events are available in Workers observability logs.

R2 is checked when picture content is read or written; its availability is intentionally not part of general D1 readiness. Failed object deletions remain in a D1 outbox and the scheduled Worker retries up to 20 keys every 15 minutes.

## Upgrades

1. Run `npm run verify`.
2. Create one maintenance-window recovery point for D1 and R2 using [the backup runbook](backup-and-restore.md). Expect D1 export to interrupt database requests briefly.
3. Apply pending D1 migrations remotely.
4. Deploy the Worker and static assets.
5. Confirm readiness and representative reads before making a write.

D1 migrations are forward-only. Roll back application code only when it remains compatible with the migrated schema; otherwise restore into newly provisioned resources and switch the bindings after verification.

## Legacy container

The Kotlin/SQLite container remains in the repository as a local fallback and migration source. It is not the production deployment unit. Keep its stopped volume until the Cloudflare cutover and backups have been verified.
