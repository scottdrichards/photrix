import { queryCacheKey, WriteInvalidatedCache } from "./writeInvalidatedCache.ts";
import { runWithRequestAbortSignal, getRequestAbortSignal } from "./requestAbort.ts";

const counter = () => {
  const calls = { count: 0 };
  return { calls, compute: () => Promise.resolve(++calls.count) };
};

describe("WriteInvalidatedCache", () => {
  it("serves the cached result while the generation is unchanged", async () => {
    const cache = new WriteInvalidatedCache(() => 0, 4);
    const { calls, compute } = counter();
    expect(await cache.get("k", compute)).toBe(1);
    expect(await cache.get("k", compute)).toBe(1);
    expect(calls.count).toBe(1);
  });

  it("recomputes once the generation changes", async () => {
    const state = { generation: 0 };
    const cache = new WriteInvalidatedCache(() => state.generation, 4);
    const { compute } = counter();
    expect(await cache.get("k", compute)).toBe(1);
    state.generation++;
    expect(await cache.get("k", compute)).toBe(2);
    expect(await cache.get("k", compute)).toBe(2);
  });

  it("does not keep a result whose read overlapped a write", async () => {
    const state = { generation: 0 };
    const cache = new WriteInvalidatedCache(() => state.generation, 4);
    const gate: { open?: (value: string) => void } = {};
    const stale = cache.get("k", () => new Promise<string>((resolve) => (gate.open = resolve)));
    // A write lands while the read is still running.
    state.generation++;
    gate.open?.("read before the write");
    expect(await stale).toBe("read before the write");
    expect(await cache.get("k", () => Promise.resolve("read after the write"))).toBe(
      "read after the write",
    );
  });

  it("shares one read between concurrent callers", async () => {
    const cache = new WriteInvalidatedCache(() => 0, 4);
    const { calls, compute } = counter();
    expect(await Promise.all([cache.get("k", compute), cache.get("k", compute)])).toEqual([1, 1]);
    expect(calls.count).toBe(1);
  });

  it("keeps keys apart", async () => {
    const cache = new WriteInvalidatedCache(() => 0, 4);
    expect(await cache.get("a", () => Promise.resolve("A"))).toBe("A");
    expect(await cache.get("b", () => Promise.resolve("B"))).toBe("B");
    expect(await cache.get("a", () => Promise.resolve("other"))).toBe("A");
  });

  it("does not cache a failure", async () => {
    const cache = new WriteInvalidatedCache(() => 0, 4);
    await expect(cache.get("k", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await cache.get("k", () => Promise.resolve("ok"))).toBe("ok");
  });

  it("evicts the least recently used entry beyond the limit", async () => {
    const cache = new WriteInvalidatedCache(() => 0, 2);
    await cache.get("a", () => Promise.resolve("A1"));
    await cache.get("b", () => Promise.resolve("B1"));
    await cache.get("a", () => Promise.resolve("unused")); // touch a; b is now the oldest
    await cache.get("c", () => Promise.resolve("C1"));
    expect(await cache.get("a", () => Promise.resolve("A2"))).toBe("A1");
    expect(await cache.get("b", () => Promise.resolve("B2"))).toBe("B2");
  });

  it("bypasses the cache for a null key", async () => {
    const cache = new WriteInvalidatedCache(() => 0, 4);
    const { calls, compute } = counter();
    await cache.get(null, compute);
    await cache.get(null, compute);
    expect(calls.count).toBe(2);
  });

  it("runs the shared read outside the first caller's abort signal", async () => {
    const cache = new WriteInvalidatedCache(() => 0, 4);
    const seen = await runWithRequestAbortSignal(new AbortController().signal, () =>
      cache.get("k", () => Promise.resolve(getRequestAbortSignal())),
    );
    expect(seen).toBeUndefined();
  });
});

describe("queryCacheKey", () => {
  it("separates the same SQL with different parameters", () => {
    expect(queryCacheKey("SELECT ?", [1])).not.toBe(queryCacheKey("SELECT ?", [2]));
    expect(queryCacheKey("SELECT ?", [1])).not.toBe(queryCacheKey("SELECT ?", ["1"]));
    expect(queryCacheKey("SELECT ?", [1])).toBe(queryCacheKey("SELECT ?", [1]));
  });

  it("refuses parameters it cannot compare", () => {
    expect(queryCacheKey("SELECT ?", [Buffer.from([1])])).toBeNull();
    expect(queryCacheKey("SELECT ?", [new Float32Array(2)])).toBeNull();
  });
});
