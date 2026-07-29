# requestHandlers

HTTP request handlers wired up in `createServer.ts`. Each handler owns one route group.

## Route map

| Handler                      | Route prefix       | Notes                                                |
| ---------------------------- | ------------------ | ---------------------------------------------------- |
| `authRequestHandler`         | `/api/auth`        | Passkey registration/login, token issue              |
| `diagnosticsRequestHandler`  | `/api/diagnostics` | Client-event logging endpoint                        |
| `files/filesRequestHandler`  | `/api/files/`      | Core media serving: thumbnails, previews, HLS, crops |
| `foldersRequestHandler`      | `/api/folders/`    | Folder summary queries                               |
| `peopleRequestHandler`       | `/api/people/`     | Rename, merge, separate face clusters                |
| `searchRequestHandler`       | `/api/search`      | CLIP/audio/transcript semantic search                |
| `statusRequestHandler`       | `/api/status`      | Server status SSE stream + background-tasks toggle   |
| `suggestionsRequestHandler`  | `/api/suggestions` | Autocomplete field values                            |
| `networkProbeRequestHandler` | `/api/probe`       | Latency/bandwidth probe (no-cache)                   |
| `video/`                     | `/api/video/`      | Video playback negotiation (HLS vs direct)           |

## Cache headers

- Served file representations (thumbnails, previews, originals) → `public, max-age=31536000, immutable`. URLs include content-keyed params so they are effectively immutable once issued.
- Status SSE stream → `no-cache, no-transform` (must not buffer).
- Network probe → `no-store, no-cache` (must not cache at any layer).

## Request-abort integration

Every handler that touches `IndexDatabase` must supply the `AbortSignal` from `AsyncLocalStorage` (via `getRequestAbortSignal()`). The DB read queue drops stale queries when the signal fires, so long filter queries are automatically cancelled if the client disconnects. Short mutations (inserts/updates) should use `runWithoutRequestAbortSignal`.
