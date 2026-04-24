import { Worker } from "node:worker_threads";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const workerScriptPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "sqliteWorker.ts",
);

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

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

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

  return worker;
};

export class AsyncSqlite {
  /** Handles writes: run, exec, transaction */
  private writeWorker: Worker;
  /** Handles reads: get, all  separate worker so writes never block reads in WAL mode */
  private readWorker: Worker;
  private nextId = 0;
  private pending = new Map<number, PendingRequest>();

  private rejectAllPending(error: Error): void {
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
      console.error(`[async-sqlite] ${label} worker error`, error);
      this.rejectAllPending(error);
    });

    worker.on("messageerror", (error) => {
      console.error(`[async-sqlite] ${label} worker message error`, error);
      this.rejectAllPending(
        new Error(`AsyncSqlite ${label} worker message error: ${error.message}`),
      );
    });

    worker.on("exit", (code) => {
      if (this.pending.size === 0) return;
      console.warn(
        `[async-sqlite] ${label} worker exited with code ${code} while requests were pending`,
      );
      this.rejectAllPending(
        new Error(
          `AsyncSqlite ${label} worker exited with code ${code} while requests were pending`,
        ),
      );
    });
  }

  private constructor(writeWorker: Worker, readWorker: Worker) {
    this.writeWorker = writeWorker;
    this.readWorker = readWorker;
    this.attachWorkerHandlers(writeWorker, "write");
    this.attachWorkerHandlers(readWorker, "read");
  }

  static async open(
    dbPath: string,
    options: AsyncSqliteOptions = {},
  ): Promise<AsyncSqlite> {
    const writeWorker = await spawnWorker(dbPath, { ...options, readonly: false });
    try {
      const readWorker = await spawnWorker(dbPath, {
        readonly: true,
        customFunctions: options.customFunctions,
      });
      return new AsyncSqlite(writeWorker, readWorker);
    } catch (error) {
      await writeWorker.terminate();
      throw error;
    }
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

  async get<T = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): Promise<T | undefined> {
    return this.send<T | undefined>(this.readWorker, "get", { sql, params });
  }

  async all<T = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): Promise<T[]> {
    return this.send<T[]>(this.readWorker, "all", { sql, params });
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
    await Promise.all([
      this.send<void>(this.writeWorker, "close"),
      this.send<void>(this.readWorker, "close"),
    ]);
    await Promise.all([this.writeWorker.terminate(), this.readWorker.terminate()]);
  }
}
