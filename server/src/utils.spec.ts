import { batch } from "./utils.ts";

describe("batch", () => {
  it("groups array items into fixed-size chunks", () => {
    expect(Array.from(batch([1, 2, 3, 4, 5], 2))).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("accepts generic iterables such as sets", () => {
    expect(Array.from(batch(new Set([1, 2, 3]), 2))).toEqual([[1, 2], [3]]);
  });

  it("accepts iterators such as generator results", () => {
    function* values() {
      yield "a";
      yield "b";
      yield "c";
    }

    expect(Array.from(batch(values(), 2))).toEqual([["a", "b"], ["c"]]);
  });

  it("returns no batches for empty input", () => {
    expect(Array.from(batch([], 3))).toEqual([]);
  });

  it("rejects non-positive batch sizes", () => {
    expect(() => Array.from(batch([1, 2, 3], 0))).toThrow(
      "batchSize must be a positive integer",
    );
    expect(() => Array.from(batch([1, 2, 3], -1))).toThrow(
      "batchSize must be a positive integer",
    );
  });

  it("rejects non-integer batch sizes", () => {
    expect(() => Array.from(batch([1, 2, 3], 1.5))).toThrow(
      "batchSize must be a positive integer",
    );
  });
});
