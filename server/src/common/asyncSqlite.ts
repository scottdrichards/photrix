import { Worker } from "node:worker_threads";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const workerScriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "sqliteWorker.ts");

type RunResult = { changes: number; lastInsertRowid: number };

type CustomFunctionType = "regexp" | "cosine_similarity";

type AsyncSqliteOptions = {
  pragmas?: string[];
  customFunctions?: Array<{
    name: string;
    options: { deterministic?: boolean };
    type: CustomFunctionType;
  }>;
};

export class AsyncSqlite {
  private worker: Worker;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private constructor(worker: Worker) {
    this.worker = worker;
    this.worker.on("message", (msg: { id: number; result?: unknown; error?: string }) => {
      if (!("id" in msg)) return;
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        entry.reject(new Error(msg.error));
      } else {
        entry.resolve(msg.result);
      }
    });

    this.worker.on("error", (error) => {
      for (const entry of this.pending.values()) {
        entry.reject(error);
      }
      this.pending.clear();
    });
  }

  static async open(dbPath: string, options: AsyncSqliteOptions = {}): Promise<AsyncSqlite> {
    const worker = new Worker(workerScriptPath, {
      workerData: {
        dbPath,
        pragmas: options.pragmas,
        customFunctions: options.customFunctions,
      },
      execArgv: ["--import", "tsx"],
    });

    await new Promise<void>((resolve, reject) => {
      const onMessage = (msg: { type?: string }) => {
        if (msg.type === "ready") {
          worker.off("message", onMessage);
          worker.off("error", onError);
          resolve();
        }
      };
      const onError = (error: Error) => {
        worker.off("message", onMessage);
        worker.off("error", onError);
        reject(error);
      };
      worker.on("message", onMessage);
      worker.on("error", onError);
    });

    return new AsyncSqlite(worker);
  }

  private send<T>(op: string, payload: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ id, op, ...payload });
    });
  }

  async get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    return this.send<T | undefined>("get", { sql, params });
  }

  async all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
    return this.send<T[]>("all", { sql, params });
  }

  async run(sql: string, ...params: unknown[]): Promise<RunResult> {
    return this.send<RunResult>("run", { sql, params });
  }

  async exec(sql: string): Promise<void> {
    await this.send<void>("exec", { sql });
  }

  async transaction(statements: Array<{ sql: string; params: unknown[] }>): Promise<void> {
    await this.send<void>("transaction", { statements });
  }

  async close(): Promise<void> {
    await this.send<void>("close");
    await this.worker.terminate();
  }
}
