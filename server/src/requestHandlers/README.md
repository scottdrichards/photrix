# requestHandlers

HTTP request handlers. Each handler owns one route group and is wired into the
route table in `../createRoutes.ts`, which also declares what a share link may
do on it (`shareLink: "forbidden" | "allowed" | "scoped"`). `createServer.ts`
owns what runs before that table: the request trace, the auth gate, and the
`/share` link-preview page (`sharePreviewRequestHandler.ts`), which checks the
share token itself.

Name a handler file `<thing>RequestHandler.ts`, exporting `<thing>RequestHandler`.
`authRequestHandler.ts` exports several (`authLoginHandler`, …) because they
share one module's state; `files/` and `video/` hold the file-serving helpers.

## Keep handlers thin

A handler parses the request, calls the module that does the work, and maps
the result to a status and body. Logic that would make sense without HTTP
(encode queueing, fetching, scoring, caching) belongs in that module, behind
a typed result the handler can switch on. For example, `files/videoRepresentations.ts`
maps `videoProcessing/hlsService.ts`'s `HlsResponse`, and
`faceIdentifyRequestHandler.ts` maps `faceDetection/faceIdentify/`'s `IdentifyResult`.
Streaming and Range handling for served files is `files/streamFile.ts`.

Specs call a handler directly with `handlerTest.fixture.ts` (`fakeRequest`,
`recordResponse`) and test its contract: status codes, validation, and what
it refuses. Which routes a share link reaches is tested once, in
`createServer.spec.ts`.

## Adding a route

1. Write the handler here (read a body with `readJsonRequest` from `common/readBody.ts`),
   and a `<thing>RequestHandler.spec.ts` beside it.
2. Add a `Route` entry in `createRoutes.ts` with the narrowest `shareLink`
   that works, and a case in `createServer.spec.ts` if share links may reach it
   (`createRoutes.spec.ts` checks every route is under `/api/` and reachable).
3. Add a row to the route table in `/documentation/ARCHITECTURE.md` and the
   endpoint to `server/API.md`.

## Route map

See `/documentation/ARCHITECTURE.md` (route → handler → the module doing the
work). Keep that table current when adding a route.

## Cache headers

- Served file representations (thumbnails, previews, originals) → `public, max-age=31536000, immutable`. URLs include content-keyed params so they are effectively immutable once issued.
- Status SSE stream → `no-cache, no-transform` (must not buffer).
- Network probe → `no-store, no-cache` (must not cache at any layer).

## Request-abort integration

Every handler that touches `IndexDatabase` must supply the `AbortSignal` from `AsyncLocalStorage` (via `getRequestAbortSignal()`). The DB read queue drops stale queries when the signal fires, so long filter queries are automatically cancelled if the client disconnects. Short mutations (inserts/updates) should use `runWithoutRequestAbortSignal`.
