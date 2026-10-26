# Common utilities

Cross-cutting helpers shared across the server.

## SQLite off the main thread — `asyncSqlite.ts` + `sqliteWorker.ts`

`better-sqlite3` is synchronous and would block Node's event loop. `AsyncSqlite`
runs it in **worker threads** and talks to them over request/response messages.

- **Two workers per database**: one **write** worker (`run`/`exec`/`transaction`)
  and one read-only **read** worker (`get`/`all`). In WAL mode this lets reads
  proceed without being blocked by writes.
- `AsyncSqlite.open()` spawns both, waits for each worker's `ready` message, and
  applies `pragmas` + registered `customFunctions` once at startup.
- Each request gets a numeric id; replies are matched back via a `pending` map.
  If a worker errors/exits with requests outstanding, **all** pending requests
  are rejected (so callers fail fast rather than hang).

### Custom SQL functions (`sqliteWorker.ts`)

- `regexp` — JS `RegExp.test`; invalid patterns return 0 instead of throwing.
- `cosine_similarity_i8(a, b)` — cosine over two int8 embedding blobs (layout in
  `indexDatabase/embeddingCodec.ts`), for queries that compare against a
  *subset* of vectors inside SQL (face-cluster growth, the `semantic` filter).
  Whole-library semantic search does not use it: one JavaScript call per row
  made a 177k-photo scan take ~5 s. That goes through the in-memory index in
  `indexDatabase/vectorIndex/` instead.

## Cache paths — `cacheUtils.ts`

Derives on-disk cache locations under `CACHE_DIR` (default `.cache`).
`getMirroredCache*` mirror the source tree under `media/<rootKey>/<dir>/<name>/`
so cached artifacts (thumbnails, HLS, web-safe video) live alongside a
predictable, collision-free path derived from the source file.
`initializeCacheDirectories()` is called once at startup.
