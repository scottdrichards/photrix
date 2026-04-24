import type * as http from "http";

export type AssertNever<T extends never> = T;

export type UnionXOR<A, B> = Exclude<A, B> | Exclude<B, A>;
export const writeJson = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

/**
 * Batches an iterable into smaller arrays of a specified size.
 */
export const batch = <T>(
  iterable: Iterable<T>,
  batchSize: number,
): IterableIterator<T[]> => {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new RangeError("batchSize must be a positive integer");
  }

  const iterator = iterable[Symbol.iterator]();
  const batchIterator: IterableIterator<T[]> = {
    [Symbol.iterator]() {
      return this;
    },
    next(): IteratorResult<T[]> {
      const result: T[] = [];
      for (let i = 0; i < batchSize; i++) {
        const next = iterator.next();
        if (next.done) {
          break;
        }
        result.push(next.value);
      }
      if (result.length === 0) {
        return { done: true, value: undefined };
      }
      return { done: false, value: result };
    },
  };
  return batchIterator;
};

export const formatDuration = (totalSeconds: number): string => {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;

  return `${hours}h ${minutes}m ${seconds}s`;
};
