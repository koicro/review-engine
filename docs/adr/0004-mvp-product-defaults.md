# ADR 0004: MVP product defaults

- Status: Accepted
- Date: 2026-08-13

## Context

The draft specification left authentication precedence, UI language, aggregate display, reviewer scope, public entity pages, and the final web stack undecided. Each affects the initial public contract and reference UI.

## Decision

- Use built-in credentials: revocable bearer tokens for API clients and short-lived opaque, server-side sessions for the official browser UI. A reverse proxy may terminate TLS but its identity headers are not trusted.
- Keep all data private and authenticated. Public entity pages and anonymous read access are outside the MVP.
- Ship an English reference UI first and treat English as the fallback locale. Source all user-facing UI copy from the typed English message catalog; adding locale selection and translated catalogs remains follow-up work.
- Use the fixed default reviewer in the MVP UI. The data model and API retain reviewer IDs for future multi-reviewer support.
- Show the unweighted normalized aggregate only as secondary context; criterion projections remain primary.
- Adopt TypeScript, React, and Vite for the reference UI.

## Consequences

Bearer and browser-session authentication resolve to the same built-in authority; browser cookies add no independent identity model. Deployments remain private by construction. Reviewer administration, public pages, proxy-header authentication, and additional locale catalogs and selection require later ADRs and explicit API/UI work. Aggregate values must not be persisted or presented as the sole evaluation.
