import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";

type WorkerInit = {
  dbPath: string;
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
  | { id: number; op: "transaction"; statements: Array<{ sql: string; params: unknown[] }> }
  | { id: number; op: "close" };

const init = workerData as WorkerInit;
const db = new Database(init.dbPath);

for (const pragma of init.pragmas ?? []) {
  db.pragma(pragma);
}

for (const fn of init.customFunctions ?? []) {
  if (fn.type === "regexp") {
    db.function(fn.name, { deterministic: fn.options.deterministic ?? true }, (pattern: string, text: string) => {
      try {
        return new RegExp(pattern).test(text) ? 1 : 0;
      } catch {
        return 0;
      }
    });
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
          dot += left[i]! * right[i]!;
          leftMag += left[i]! * left[i]!;
          rightMag += right[i]! * right[i]!;
        }
        const denom = Math.sqrt(leftMag) * Math.sqrt(rightMag);
        return denom > 0 ? dot / denom : 0;
      },
    );
  }
}

parentPort!.postMessage({ type: "ready" });

parentPort!.on("message", (msg: WorkerMessage) => {
  try {
    switch (msg.op) {
      case "get": {
        const result = db.prepare(msg.sql).get(...msg.params);
        parentPort!.postMessage({ id: msg.id, result });
        break;
      }
      case "all": {
        const result = db.prepare(msg.sql).all(...msg.params);
        parentPort!.postMessage({ id: msg.id, result });
        break;
      }
      case "run": {
        const info = db.prepare(msg.sql).run(...msg.params);
        parentPort!.postMessage({ id: msg.id, result: { changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) } });
        break;
      }
      case "exec": {
        db.exec(msg.sql);
        parentPort!.postMessage({ id: msg.id, result: undefined });
        break;
      }
      case "transaction": {
        const tx = db.transaction((stmts: Array<{ sql: string; params: unknown[] }>) => {
          for (const stmt of stmts) {
            db.prepare(stmt.sql).run(...stmt.params);
          }
        });
        tx(msg.statements);
        parentPort!.postMessage({ id: msg.id, result: undefined });
        break;
      }
      case "close": {
        db.close();
        parentPort!.postMessage({ id: msg.id, result: undefined });
        break;
      }
    }
  } catch (error) {
    parentPort!.postMessage({
      id: msg.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
