# ADR 0003: Single OCI image

- Status: Accepted
- Date: 2026-08-13

## Context

The project needs a low-friction self-hosted distribution while supporting both the reference UI and API-only use.

## Decision

Publish one multi-architecture OCI image containing the Ktor fat JAR, built reference UI, migrations, and a JVM 21 runtime. Serve the UI by default and disable it with `REVIEW_UI_ENABLED=false`. Publish the same release for `linux/amd64` and `linux/arm64`.

Run as a non-root user. Store the SQLite file outside the image in a mounted `/data` volume, write logs to standard output, and require no network access during application startup.

## Consequences

The standard and headless configurations exercise the same server artifact and migration path. The image is larger than an API-only or native executable, but release and support complexity remain low. A UI-free image or native image requires a later ADR backed by measured operational need.
