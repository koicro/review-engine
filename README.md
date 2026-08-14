# Review Engine

Review Engine is a self-hosted engine for evaluating arbitrary entities against versioned, category-specific criteria. Reviews are retained as time-stamped history so that current values, averages, trends, and comparisons can be derived without overwriting prior observations.

The project is in early development. The functional and technical specification is the source of truth until the first stable release.

## Architecture

- Kotlin 2.3.20, Ktor 3.5.1, and JVM 21 for the API
- SQLite for local, user-owned persistence
- TypeScript and React for the reference web UI
- One OCI image containing the API, migrations, web assets, and a Java runtime
- A modular monolith with domain, application, API, persistence, and web boundaries

The Gradle `backend` module contains the server. The `web` directory is built independently and copied into the server's classpath resources when the container image is assembled.

## Run with Docker Compose

Docker with Compose v2 is the only prerequisite for the packaged application.

```sh
export REVIEW_ADMIN_TOKEN='replace-with-a-long-random-value'
docker compose up --build
```

The application listens on [http://localhost:8080](http://localhost:8080). Readiness is exposed at `/api/v1/health/ready`.
Open **Settings** and enter `REVIEW_ADMIN_TOKEN` once. The reference UI exchanges it for an HttpOnly, SameSite browser session and does not retain the administrator token in web storage.

To run the same image without the reference UI:

```sh
REVIEW_UI_ENABLED=false docker compose up --build
```

Compose stores the SQLite database in the named `review-engine-data` volume. Running `docker compose down` preserves it; do not add `--volumes` unless the stored data should be deleted.

## Local development

Install JVM 21, Node.js 24, and npm. The committed wrapper supplies Gradle 8.14.3. Then run:

```sh
./gradlew :backend:run
```

In a second terminal:

```sh
npm --prefix web ci
npm --prefix web run dev
```

Run the checks used by CI:

```sh
./gradlew :backend:check
npm --prefix web test
npm --prefix web run build
docker compose config
docker build --tag review-engine:local .
bash scripts/container-smoke.sh review-engine:local
```

## Operations

- [Deployment guide](docs/deployment.md)
- [Backup and restore](docs/backup-and-restore.md)
- [Architecture decisions](docs/adr/README.md)
- [Decisions still required](docs/decisions-needed.md)

## License

The OSS license is not yet selected. Do not redistribute a release until the license decision is recorded and a `LICENSE` file is added.
