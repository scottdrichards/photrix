import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";

// Runs synchronous better-sqlite3 calls off the main thread.
// AsyncSqlite talks to this worker over request/response messages.

type WorkerInit = {
  dbPath: string;
  readonly?: boolean;
  pragmas?: string[];
  customFunctions?: Array<{
    name: string;
    options: { deterministic?: boolean };
    type: "regexp" | "cosine_similarity" | "cosine_similarity_f32";
  }>;
};

// Cosine similarity between two BLOBs each holding a packed array of floats.
// `bytesPerEl` selects the element width: Float64 (8 bytes) for face embeddings,
// Float32 (4 bytes) for CLIP image embeddings. Runs entirely inside SQLite so an
// ORDER BY ... LIMIT over the table never materialises every row's embedding on
// the JS heap.
//
// This is invoked once per candidate row — hundreds of thousands of times for a
// single semantic search over a large library — so per-row overhead dominates
// the query. The earlier implementation copied BOTH blobs into freshly
// allocated aligned buffers on every call (to satisfy TypedArray's alignment
// requirement); those two allocations per row, not the arithmetic, were the bulk
// of the cost. DataView imposes no alignment requirement, so we read each value
// in place straight from the SQLite blob with zero allocation. Stored vectors
// are little-endian (written from a TypedArray on an LE host), so we read LE.
const cosineSimilarityBlob = (
  a: Buffer | null,
  b: Buffer | null,
  bytesPerEl: number,
): number => {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  // Blobs must hold whole values; a truncated/odd-length blob would otherwise
  // throw a RangeError and surface as an opaque SQL error.
  if (a.length % bytesPerEl !== 0) return 0;
  const av = new DataView(a.buffer, a.byteOffset, a.length);
  const bv = new DataView(b.buffer, b.byteOffset, b.length);
  const n = a.length / bytesPerEl;
  const f32 = bytesPerEl === 4;
  let dot = 0;
  let leftMag = 0;
  let rightMag = 0;
  for (let i = 0; i < n; i++) {
    const off = i * bytesPerEl;
    const x = f32 ? av.getFloat32(off, true) : av.getFloat64(off, true);
    const y = f32 ? bv.getFloat32(off, true) : bv.getFloat64(off, true);
    dot += x * y;
    leftMag += x * x;
    rightMag += y * y;
  }
  const denom = Math.sqrt(leftMag) * Math.sqrt(rightMag);
  return denom > 0 ? dot / denom : 0;
};

type WorkerMessage =
  | { id: number; op: "get"; sql: string; params: unknown[] }
  | { id: number; op: "all"; sql: string; params: unknown[] }
  | { id: number; op: "run"; sql: string; params: unknown[] }
  | { id: number; op: "exec"; sql: string }
  | {
      id: number;
      op: "transaction";
      statements: Array<{ sql: string; params: unknown[] }>;
    }
  | { id: number; op: "close" };

const init = workerData as WorkerInit;
const workerLabel = init.readonly ? "read" : "write";
const db = new Database(init.dbPath, { readonly: init.readonly ?? false });

// Apply connection-level settings once at startup.
for (const pragma of init.pragmas ?? []) {
  db.pragma(pragma);
}

// Register app-specific SQL functions on this connection.
for (const fn of init.customFunctions ?? []) {
  if (fn.type === "regexp") {
    db.function(
      fn.name,
      { deterministic: fn.options.deterministic ?? true },
      (pattern: string, text: string) => {
        try {
          return new RegExp(pattern).test(text) ? 1 : 0;
        } catch {
          return 0;
        }
      },
    );
  }

  if (fn.type === "cosine_similarity") {
    db.function(
      fn.name,
      { deterministic: fn.options.deterministic ?? true },
      (a: Buffer | null, b: Buffer | null) => cosineSimilarityBlob(a, b, 8),
    );
  }

  if (fn.type === "cosine_similarity_f32") {
    db.function(
      fn.name,
      { deterministic: fn.options.deterministic ?? true },
      (a: Buffer | null, b: Buffer | null) => cosineSimilarityBlob(a, b, 4),
    );
  }
}

// Signal readiness so callers do not enqueue operations before init completes.
parentPort!.postMessage({ type: "ready" });

parentPort!.on("message", (msg: WorkerMessage) => {
  try {
    let result: unknown;

    switch (msg.op) {
      case "get": {
        result = db.prepare(msg.sql).get(...msg.params);
        break;
      }
      case "all": {
        result = db.prepare(msg.sql).all(...msg.params);
        break;
      }
      case "run": {
        const info = db.prepare(msg.sql).run(...msg.params);
        result = {
          changes: info.changes,
          lastInsertRowid: Number(info.lastInsertRowid),
        };
        break;
      }
      case "exec": {
        db.exec(msg.sql);
        result = undefined;
        break;
      }
      case "transaction": {
        // Execute all statements atomically on this single connection.
        const tx = db.transaction((stmts: Array<{ sql: string; params: unknown[] }>) => {
          for (const stmt of stmts) {
            db.prepare(stmt.sql).run(...stmt.params);
          }
        });
        tx(msg.statements);
        result = undefined;
        break;
      }
      case "close": {
        db.close();
        result = undefined;
        break;
      }
    }

    parentPort!.postMessage({ id: msg.id, result });
  } catch (error) {
    parentPort!.postMessage({
      id: msg.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
