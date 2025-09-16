# server

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.1.43. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.

## Handler Architecture

Incoming requests to `/media/...` are processed by an ordered list of handlers found in `server/handlers`. Each handler:

1. Receives a `RequestContext` (`req`, `res`, parsed URL pieces, derived paths, query params, width hints, etc.).
2. Decides quickly if it applies. If not, returns `NOT_HANDLED`.
3. If it applies, it writes the response directly (`res.writeHead`, `res.end`, piping streams) and returns (any non-`NOT_HANDLED` value / void).
4. May throw to signal an internal error (caught by the dispatcher) or a special error code (e.g. `ENOENT` to move on, `ESEGMENT_NOT_READY` for retry semantics).

Current order (top -> first match wins):

1. `directoryHandler` – folder listings, distinct column values, filtered search results (gzipped)  
2. `dashHandler` – MPEG-DASH MPD and segment delivery with on-demand encoding bootstrap  
3. `heicImageHandler` – converts HEIC/HEIF to cached WebP (optionally resized)  
4. `rasterImageHandler` – JPEG/PNG/etc original or resized WebP thumb  
5. `videoThumbnailHandler` – extracts & caches video poster frames as WebP  
6. `staticFileHandler` – final fallback streaming any remaining file  

If no handler responds, a 404 is returned.

### Adding a New Handler

Create a file in `server/handlers`, export a `{ name, handle }` object conforming to `MediaRequestHandler`, then add it to `handlers/index.ts` in the desired priority position.

Key tips:

* Be fast to reject (return `NOT_HANDLED`).
* Never leave a partially-written response without ending or piping.
* For heavy CPU operations (transcoding, resizing) prefer caching results in `mediaCacheDir`.
* Use streaming (pipes) for large payloads instead of buffering whole files in memory.

### Errors & Special Codes

Handlers may throw an `Error` with a `code` property:

* `ENOENT` – treated as a miss; dispatcher falls through to next handler.
* `ESEGMENT_NOT_READY` – DASH specific; returns 503 with Retry-After.
* Anything else – logged and returns 500 (unless response already started).

### JSON Responses & Large Datasets

`directoryHandler` compresses search and listing results with gzip. For future scalability we plan to stream large JSON arrays incrementally instead of building them fully in memory (see TODO: streaming enhancement).

## Development Tips

* Run type checks: `cd server && npx tsc --noEmit`
* Clear cache directories when changing transformation logic.
* Keep handler modules focused; shared utilities can live beside them (e.g. `imageCommon.ts`).

## Pending Improvements

* Stream large JSON search results.
* Add handler unit tests around negative/edge cases.
* Conditional compression based on `Accept-Encoding`.

