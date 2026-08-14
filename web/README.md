# Review Engine reference UI

The reference UI is a Vite + React single-page application. It talks only to the public `/api/v1` API and uses hash routes so the packaged static application does not need server-side route fallbacks.

## Local development

```sh
npm install
npm run dev
```

Vite proxies `/api` and `/openapi.json` to `http://localhost:8080`. Set `REVIEW_API_PROXY` before starting Vite to use another backend origin.

Open **Settings** in the UI and enter the value configured as `REVIEW_ADMIN_TOKEN` once. The UI exchanges it at `POST /api/v1/session`, clears the input immediately, and uses the resulting HttpOnly, same-origin cookie. The administrator token is never persisted in browser storage or attached to later UI requests. Use **Sign out** to revoke the browser session with `DELETE /api/v1/session`.

The API base is stored in `localStorage`; the packaged UI should use `/api/v1` so browser session requests remain same-origin. Explicit bearer-token support in `ApiClient` is reserved for non-browser clients and tests, not official UI state.

## Validation

```sh
npm test
npm run build
```

The production bundle is emitted to `dist/` for the backend container to package as static resources.
