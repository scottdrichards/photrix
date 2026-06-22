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
- `cosine_similarity(a, b)` — operates on `Float64` BLOBs. **SQLite BLOB buffers
  are not guaranteed to be 8-byte aligned**, which a `Float64Array` view requires,
  and a truncated/odd-length blob would throw. Both are guarded: odd lengths
  return 0, and the bytes are copied into a freshly-allocated (aligned) buffer
  before the view is created. Keep these guards — a throw here surfaces as an
  opaque SQL error that breaks vector search.

## Work de-duplication — `scheduleWork.ts`

`scheduleWork(key, work)` collapses concurrent callers for the same `key` onto a
single execution and fans the result out to all waiters. The waiter list is
detached and the key cleared **before** the waiters are settled, so a caller that
arrives in the settle microtask window schedules fresh work instead of attaching
to a batch that has already fired (which would hang forever).

Use it to avoid duplicate expensive work (e.g. converting the same image twice
when two requests race).

## Cache paths — `cacheUtils.ts`

Derives on-disk cache locations under `CACHE_DIR` (default `.cache`).
`getMirroredCache*` mirror the source tree under `media/<rootKey>/<dir>/<name>/`
so cached artifacts (thumbnails, HLS, web-safe video) live alongside a
predictable, collision-free path derived from the source file.
`initializeCacheDirectories()` is called once at startup.
