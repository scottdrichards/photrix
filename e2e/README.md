# End-to-end tests (Playwright)

Browser tests that drive the real Photrix app so a change can be validated without
a human clicking around. Chromium-only, headless by default.

## How it stays isolated

`playwright.config.ts` boots its own server + client via Playwright's `webServer`:

- **API** on port **3399**, indexing `server/exampleFolder` into a throwaway
  `server/.cache-e2e` DB, with auth disabled. Because `server/src/main.ts` loads
  `.env` via `dotenv/config` (which never overrides already-set env vars), the env
  injected here wins — the real library, DB, cache, and `AUTH_PASSWORD` are never
  touched.
- **Client** (Vite) on port **5273**, with its `/api` proxy pointed at 3399 via the
  `PHOTRIX_API_TARGET` env var (see `client/vite.config.ts`).

Dedicated ports mean you can run the suite while a normal dev server (3000/5173) is
also up. `globalSetup.ts` deletes `server/.cache-e2e` before each run for a clean
index (matches the repo's "rebuild, don't migrate" data policy).

## First-time setup

Dependencies are installed once for the whole repo via `bun install` (or
`bun run bootstrap`) from the repo root — see `GETTING_STARTED.md`. The one
extra step for e2e is downloading Playwright's browser binary:

```bash
bun run test:e2e:install   # from repo root — downloads headless Chromium
```

If Chromium fails to launch on a missing system library, install the OS deps
(needs root): `sudo e2e/node_modules/.bin/playwright install-deps chromium`.

## Running

```bash
bun run test:e2e                     # from repo root — boots servers, runs headless
bun run --filter photrix-e2e test    # equivalent
bun run --filter photrix-e2e report  # open the last HTML report
```

On failure, traces, screenshots, and video land in `e2e/test-results/` and the HTML
report in `e2e/playwright-report/` for inspection.

## Writing tests

Tests live in `tests/*.spec.ts` and should read like a specification of what the
user experiences — prefer role/label/testid queries over CSS internals. `data-testid`
hooks are added sparingly in the client where no stable accessible handle exists
(e.g. `thumbnail-grid`).
