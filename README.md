# Review Engine

Review Engine evaluates arbitrary entities against versioned, category-specific criteria. Reviews remain as time-stamped history, enabling current values, averages, trends, and comparisons without overwriting earlier observations.

Production runs on [Cloudflare Workers](https://review-engine.okamo.workers.dev): the Worker serves the React application and API, D1 stores relational data, and R2 stores review pictures.

## Architecture

- TypeScript Worker API on Cloudflare Workers
- D1 for categories, templates, entities, reviews, relations, sessions, and access tokens
- R2 for immutable review-picture objects, limited to three per review and 100,000,000 bytes each
- React and TypeScript frontend served through Workers Static Assets
- Kotlin/Ktor, SQLite, and the OCI image retained as a local fallback and migration source

The canonical runtime is in `worker/`, D1 migrations are in `migrations/`, and the frontend is in `web/`. `wrangler.jsonc` declares every production binding.

## Local Worker development

Install Node.js 24 and npm, then:

```sh
npm ci
npm --prefix web ci
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply review-engine-db --local
npm run dev
```

Replace the placeholder in `.dev.vars` with a random administrator credential containing at least 32 characters. Wrangler serves the frontend and API together and emulates D1 and R2 locally.

Run all current checks with:

```sh
npm run verify
```

## Deploy

Authenticate Wrangler, review `wrangler.jsonc`, then apply migrations and deploy:

```sh
npx wrangler d1 migrations apply review-engine-db --remote
npm run deploy
npx wrangler secret put REVIEW_ADMIN_TOKEN
```

Enter a random, production-only administrator credential of at least 32 characters when prompted. Do not put it in `wrangler.jsonc` or version control.

## Legacy local container

The previous Kotlin/SQLite build remains available for rollback and data inspection:

```sh
export REVIEW_ADMIN_TOKEN='replace-with-a-long-random-value'
docker compose up --build
```

It listens on [http://localhost:8080](http://localhost:8080). Its named volume is preserved by `docker compose down`; never add `--volumes` unless deletion is intentional.

## Operations

- [Deployment guide](docs/deployment.md)
- [Backup and restore](docs/backup-and-restore.md)
- [Architecture decisions](docs/adr/README.md)

## License

The OSS license is not yet selected. Do not redistribute a release until the decision is recorded and a `LICENSE` file is added.
