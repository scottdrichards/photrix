import { runWithoutRequestAbortSignal } from "./requestAbort.ts";

type Entry = { generation: number; value: Promise<unknown> };

type Primitive = string | number | boolean | null;

const isPrimitive = (value: unknown): value is Primitive =>
  value === null ||
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean";

/**
 * A cache key for a query, or null when a parameter can't be part of one (an
 * embedding blob, say): such a query is simply not cached.
 */
export const queryCacheKey = (sql: string, params: readonly unknown[]): string | null =>
  params.every(isPrimitive) ? `${sql}\u0000${JSON.stringify(params)}` : null;

/**
 * Remembers the result of a read until the database is next written.
 *
 * `generation` must change whenever a write starts and whenever one settles
 * (see `AsyncSqlite.writeGeneration`). An entry is served only while the
 * generation still equals the one taken before its read began, so a result can
 * never outlive a write that started before, during or after it.
 *
 * Concurrent callers share one read. Results are shared too: treat them as
 * read-only.
 */
export class WriteInvalidatedCache {
  private readonly entries = new Map<string, Entry>();
  private readonly generation: () => number;
  private readonly maxEntries: number;

  constructor(generation: () => number, maxEntries: number) {
    this.generation = generation;
    this.maxEntries = maxEntries;
  }

  /** A null key bypasses the cache. */
  get<T>(key: string | null, compute: () => Promise<T>): Promise<T> {
    if (key === null) return compute();

    const generation = this.generation();
    const hit = this.entries.get(key);
    if (hit && hit.generation === generation) {
      // Re-insert so the map's order stays least-recently-used first.
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit.value as Promise<T>;
    }

    // The read outlives the request that started it: every later caller waits
    // on the same promise, so the first caller disconnecting must not abort it.
    const value = runWithoutRequestAbortSignal(compute);
    const entry: Entry = { generation, value };
    this.entries.delete(key);
    this.entries.set(key, entry);
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) break;
      this.entries.delete(oldest);
    }
    // A failed read is not a result. Drop it so the next caller retries; this
    // caller still gets the rejection through the returned promise.
    value.catch(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    return value;
  }
}
