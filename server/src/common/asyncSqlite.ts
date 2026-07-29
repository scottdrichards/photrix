import { Worker } from "node:worker_threads";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getRequestAbortSignal } from "./requestAbort.ts";

const workerScriptPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "sqliteWorkerEntry.mjs",
);

type RunResult = { changes: number; lastInsertRowid: number };

type CustomFunctionType = "regexp" | "cosine_similarity" | "cosine_similarity_f32";

type AsyncSqliteOptions = {
  pragmas?: string[];
  /** Number of read workers (default: PHOTRIX_DB_READ_WORKERS env or 2). */
  readPoolSize?: number;
  customFunctions?: Array<{
    name: string;
    options: { deterministic?: boolean };
    type: CustomFunctionType;
  }>;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type ReadQueueEntry = {
  id: number;
  message: Record<string, unknown>;
  settle: PendingRequest;
  cleanup?: () => void;
};

const abortError = (): Error =>
  Object.assign(new Error("Query aborted: client disconnected"), {
    name: "AbortError",
  });

const spawnWorker = async (
  dbPath: string,
  options: AsyncSqliteOptions & { readonly?: boolean },
): Promise<Worker> => {
  const worker = new Worker(workerScriptPath, {
    workerData: {
      dbPath,
      readonly: options.readonly ?? false,
      pragmas: options.pragmas,
      customFunctions: options.customFunctions,
    },
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

  return worker;
};

export class AsyncSqlite {
  /** Handles writes: run, exec, transaction */
  private writeWorker: Worker;
  /**
   * Handles reads: get, all — separate workers so writes never block reads in
   * WAL mode, and a pool so one slow query doesn't block fast ones behind it.
   */
  private readWorkers: Worker[];
  private idleReadWorkers: Worker[];
  private nextId = 0;
  private pending = new Map<number, PendingRequest>();
  // Reads are queued here instead of in the workers' message ports, so a query
  // whose HTTP request was aborted (client disconnected, superseded map zoom)
  // can be dropped before a synchronous read worker ever runs it.
  private readQueue: ReadQueueEntry[] = [];

  private rejectAllPending(error: Error): void {
    const queued = this.readQueue.splice(0);
    for (const entry of queued) {
      entry.cleanup?.();
      entry.settle.reject(error);
    }
    for (const [id, entry] of this.pending.entries()) {
      this.pending.delete(id);
      entry.reject(error);
    }
  }

  private attachWorkerHandlers(worker: Worker, label: "read" | "write"): void {
    worker.on("message", (msg: { id: number; result?: unknown; error?: string }) => {
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

    worker.on("error", (error) => {
      this.rejectAllPending(error);
    });

    worker.on("messageerror", (error) => {
      this.rejectAllPending(
        new Error(`AsyncSqlite ${label} worker message error: ${error.message}`),
      );
    });

    worker.on("exit", (code) => {
      if (this.pending.size === 0) return;
      this.rejectAllPending(
        new Error(
          `AsyncSqlite ${label} worker exited with code ${code} while requests were pending`,
        ),
      );
    });
  }

  private constructor(writeWorker: Worker, readWorkers: Worker[]) {
    this.writeWorker = writeWorker;
    this.readWorkers = readWorkers;
    this.idleReadWorkers = [...readWorkers];
    this.attachWorkerHandlers(writeWorker, "write");
    for (const worker of readWorkers) {
      this.attachWorkerHandlers(worker, "read");
    }
  }

  static async open(
    dbPath: string,
    options: AsyncSqliteOptions = {},
  ): Promise<AsyncSqlite> {
    // WAL readers don't block each other, so a small pool keeps fast queries
    // flowing past a slow one. Kept small: each worker is a thread plus its own
    // SQLite connection and page cache.
    const readPoolSize =
      options.readPoolSize ?? (Number(process.env.PHOTRIX_DB_READ_WORKERS) || 2);
    const spawned: Worker[] = [];
    try {
      spawned.push(await spawnWorker(dbPath, { ...options, readonly: false }));
      for (let i = 0; i < Math.max(1, readPoolSize); i++) {
        spawned.push(
          await spawnWorker(dbPath, {
            readonly: true,
            customFunctions: options.customFunctions,
          }),
        );
      }
    } catch (error) {
      await Promise.all(spawned.map((worker) => worker.terminate()));
      throw error;
    }
    const [writeWorker, ...readWorkers] = spawned;
    return new AsyncSqlite(writeWorker, readWorkers);
  }

  private send<T>(
    worker: Worker,
    op: string,
    payload: Record<string, unknown> = {},
  ): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      worker.postMessage({ id, op, ...payload });
    });
  }

  private pumpReadQueue(): void {
    const worker = this.idleReadWorkers.pop();
    if (!worker) return;
    const entry = this.readQueue.shift();
    if (!entry) {
      this.idleReadWorkers.push(worker);
      return;
    }
    const release = () => {
      entry.cleanup?.();
      this.idleReadWorkers.push(worker);
      this.pumpReadQueue();
    };
    this.pending.set(entry.id, {
      resolve: (value) => {
        release();
        entry.settle.resolve(value);
      },
      reject: (error) => {
        release();
        entry.settle.reject(error);
      },
    });
    worker.postMessage(entry.message);
  }

  private sendRead<T>(op: string, payload: Record<string, unknown>): Promise<T> {
    const signal = getRequestAbortSignal();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      // The caller must be settled at most once: an in-flight abort rejects it
      // immediately, then the worker's eventual reply must be discarded.
      let settled = false;
      const entry: ReadQueueEntry = {
        id,
        message: { id, op, ...payload },
        settle: {
          resolve: (value) => {
            if (settled) return;
            settled = true;
            (resolve as (v: unknown) => void)(value);
          },
          reject: (error) => {
            if (settled) return;
            settled = true;
            reject(error);
          },
        },
      };
      if (signal) {
        const onAbort = () => {
          const index = this.readQueue.indexOf(entry);
          if (index !== -1) {
            // Still queued: drop it so it never reaches the worker.
            this.readQueue.splice(index, 1);
            entry.cleanup?.();
            entry.settle.reject(abortError());
            return;
          }
          // Already running. better-sqlite3 can't interrupt a query mid-flight,
          // so unblock the caller now; the pending wrapper still fires on the
          // worker's reply to free the queue, and settle() ignores the result.
          entry.settle.reject(abortError());
        };
        signal.addEventListener("abort", onAbort, { once: true });
        entry.cleanup = () => signal.removeEventListener("abort", onAbort);
      }
      this.readQueue.push(entry);
      this.pumpReadQueue();
    });
  }

  async get<T = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): Promise<T | undefined> {
    return this.sendRead<T | undefined>("get", { sql, params });
  }

  async getFromWriteWorker<T = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): Promise<T | undefined> {
    return this.send<T | undefined>(this.writeWorker, "get", { sql, params });
  }

  async all<T = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): Promise<T[]> {
    return this.sendRead<T[]>("all", { sql, params });
  }

  async run(sql: string, ...params: unknown[]): Promise<RunResult> {
    return this.send<RunResult>(this.writeWorker, "run", { sql, params });
  }

  async exec(sql: string): Promise<void> {
    await this.send<void>(this.writeWorker, "exec", { sql });
  }

  async transaction(
    statements: Array<{ sql: string; params: unknown[] }>,
  ): Promise<void> {
    await this.send<void>(this.writeWorker, "transaction", { statements });
  }

  async close(): Promise<void> {
    // Queued reads will never be dispatched once the worker closes.
    const queued = this.readQueue.splice(0);
    for (const entry of queued) {
      entry.cleanup?.();
      entry.settle.reject(new Error("AsyncSqlite is closing"));
    }
    const workers = [this.writeWorker, ...this.readWorkers];
    await Promise.all(workers.map((worker) => this.send<void>(worker, "close")));
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}
