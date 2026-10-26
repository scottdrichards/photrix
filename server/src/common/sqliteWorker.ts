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
    type:
      | "regexp"
      | "cosine_similarity_i8";
  }>;
};

// Cosine similarity between two int8-quantized embedding blobs (see
// indexDatabase/embeddingCodec.ts for the layout: a 4-byte Float32 scale header
// followed by one int8 per dimension).
//
// The per-vector scales cancel out of cosine entirely — for q = v/s, both the
// numerator and the denominator pick up the same s_a * s_b factor — so this
// never reads the header and runs as pure integer arithmetic. That makes it
// substantially cheaper per row than the float path it replaces: no DataView
// float decoding, and the blobs it scans are a quarter the size, so the same
// full-table similarity scan touches a quarter of the pages.
const INT8_SCALE_HEADER_BYTES = 4;
const cosineSimilarityInt8 = (a: Buffer | null, b: Buffer | null): number => {
  if (!a || !b || a.length !== b.length) return 0;
  const n = a.length - INT8_SCALE_HEADER_BYTES;
  if (n <= 0) return 0;

  let dot = 0;
  let leftMag = 0;
  let rightMag = 0;
  for (let i = 0; i < n; i++) {
    // readInt8 semantics without the call overhead: bytes >= 128 are negative.
    const rawX = a[i + INT8_SCALE_HEADER_BYTES];
    const rawY = b[i + INT8_SCALE_HEADER_BYTES];
    const x = rawX > 127 ? rawX - 256 : rawX;
    const y = rawY > 127 ? rawY - 256 : rawY;
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

  if (fn.type === "cosine_similarity_i8") {
    db.function(
      fn.name,
      { deterministic: fn.options.deterministic ?? true },
      (a: Buffer | null, b: Buffer | null) => cosineSimilarityInt8(a, b),
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
