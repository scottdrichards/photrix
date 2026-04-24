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
    type: "regexp" | "cosine_similarity";
  }>;
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
      (a: Buffer | null, b: Buffer | null) => {
        if (!a || !b || a.length !== b.length || a.length === 0) return 0;
        const left = new Float64Array(a.buffer, a.byteOffset, a.byteLength / 8);
        const right = new Float64Array(b.buffer, b.byteOffset, b.byteLength / 8);
        let dot = 0;
        let leftMag = 0;
        let rightMag = 0;
        for (let i = 0; i < left.length; i++) {
          dot += left[i] * right[i];
          leftMag += left[i] * left[i];
          rightMag += right[i] * right[i];
        }
        const denom = Math.sqrt(leftMag) * Math.sqrt(rightMag);
        return denom > 0 ? dot / denom : 0;
      },
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
    console.error(`[sqlite-worker:${workerLabel}] ${msg.op}#${msg.id} failed`, error);
    parentPort!.postMessage({
      id: msg.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
