# requestHandlers

HTTP request handlers wired up in `createServer.ts`. Each handler owns one route group.

## Route map

See `/documentation/ARCHITECTURE.md` (route → handler → the module doing the
work). Keep that table current when adding a route.

## Cache headers

- Served file representations (thumbnails, previews, originals) → `public, max-age=31536000, immutable`. URLs include content-keyed params so they are effectively immutable once issued.
- Status SSE stream → `no-cache, no-transform` (must not buffer).
- Network probe → `no-store, no-cache` (must not cache at any layer).

## Request-abort integration

Every handler that touches `IndexDatabase` must supply the `AbortSignal` from `AsyncLocalStorage` (via `getRequestAbortSignal()`). The DB read queue drops stale queries when the signal fires, so long filter queries are automatically cancelled if the client disconnects. Short mutations (inserts/updates) should use `runWithoutRequestAbortSignal`.
