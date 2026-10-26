import { Worker } from "node:worker_threads";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScoredFile } from "./vectorSet.ts";
import type { EmbeddingKind, VectorIndexRequest } from "./vectorIndexProtocol.ts";

// Same dev/compiled split as AsyncSqlite: under tsx the worker needs the .mjs
// shim that registers the TypeScript loader; compiled, it is plain JavaScript.
const runningCompiled = import.meta.url.endsWith(".js");
const workerScriptPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  runningCompiled ? "vectorIndexWorker.js" : "vectorIndexWorkerEntry.mjs",
);

type FileKey = { folder: string; fileName: string };
type Request = VectorIndexRequest extends infer R ? (R extends { id: number } ? Omit<R, "id"> : never) : never;
type Response = { id: number; result?: unknown; error?: { message: string; stack?: string } };

/**
 * In-memory nearest-neighbour index over the CLIP image and CLAP audio
 * embeddings in `fileEmbeddings`, held in a worker thread.
 *
 * It replaces a full-table SQL scan that called a JavaScript similarity
 * function once per row (measured ~5.3 s per search over 177k photos) with one
 * pass over a packed int8 matrix (~0.3 s). IndexDatabase keeps it in step with
 * the table: every write to `fileEmbeddings` is mirrored here after it commits.
 */
export class VectorIndex {
  private readonly worker: Worker;
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private failure: Error | null = null;
  /** Resolves once the initial load from the database has finished. */
  readonly loaded: Promise<{ image: number; audio: number }>;

  constructor(dbPath: string) {
    this.worker = new Worker(workerScriptPath);
    // The index exists to serve the HTTP server; it must never be the reason a
    // process (a script, a test run) stays alive.
    this.worker.unref();
    this.worker.on("message", (response: Response) => {
      const entry = this.pending.get(response.id);
      if (!entry) return;
      this.pending.delete(response.id);
      if (response.error) {
        entry.reject(Object.assign(new Error(response.error.message), { stack: response.error.stack }));
      } else {
        entry.resolve(response.result);
      }
    });
    // A dead worker is not replaced: fail everything from now on, loudly, the
    // same policy AsyncSqlite applies to its workers.
    this.worker.on("error", (error: Error) => this.fail(error));
    this.worker.on("exit", (code) => this.fail(new Error(`Vector index worker exited with code ${code}`)));
    this.loaded = this.request<{ image: number; audio: number }>({ op: "load", dbPath });
  }

  upsert(kind: EmbeddingKind, file: FileKey, vector: Uint8Array): Promise<void> {
    return this.request({ op: "upsert", kind, vector, ...file });
  }

  remove(file: FileKey, kinds: EmbeddingKind[]): Promise<void> {
    return this.request({ op: "remove", kinds, ...file });
  }

  removeFolder(folderPrefix: string): Promise<void> {
    return this.request({ op: "removeFolder", folderPrefix });
  }

  move(from: FileKey, to: FileKey): Promise<void> {
    return this.request({ op: "move", from, to });
  }

  search(
    kind: EmbeddingKind,
    query: Uint8Array,
    limit: number,
    allowed?: Array<[folder: string, fileName: string]>,
  ): Promise<ScoredFile[]> {
    return this.request({ op: "search", kind, query, limit, allowed });
  }

  async close(): Promise<void> {
    this.failure ??= new Error("Vector index closed");
    await this.worker.terminate();
  }

  private request<T>(request: Request): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.worker.postMessage({ ...request, id });
    });
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const { reject } of this.pending.values()) reject(this.failure);
    this.pending.clear();
  }
}
