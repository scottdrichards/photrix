import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AsyncSqlite } from "./asyncSqlite.ts";
import { runWithRequestAbortSignal } from "./requestAbort.ts";

// Scopes a signal to one query, mirroring how createServer binds a signal per
// HTTP request.
const queryWithSignal = <T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> =>
  runWithRequestAbortSignal(signal, fn);

// Busies the synchronous read worker so queries queued behind it are
// demonstrably not yet running. About a second on a loaded dev box; it was 5M
// rows (~4 s there), which made every test waiting on it race jest's 5 s limit.
const SLOW_QUERY_ROWS = 1_000_000;
const SLOW_QUERY = `WITH RECURSIVE c(x) AS (
  SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${SLOW_QUERY_ROWS}
) SELECT COUNT(*) AS n FROM c`;
// For tests that wait for SLOW_QUERY to finish: the box may be busy.
const SLOW_TEST_TIMEOUT_MS = 20_000;

describe("AsyncSqlite read queue abort", () => {
  let dir: string;
  let db: AsyncSqlite;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "async-sqlite-spec-"));
    // Single read worker so queries deterministically queue behind SLOW_QUERY.
    db = await AsyncSqlite.open(join(dir, "test.db"), { readPoolSize: 1 });
    await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    await db.run("INSERT INTO t (v) VALUES (?)", "hello");
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs reads without a signal unchanged", async () => {
    const rows = await db.all<{ v: string }>("SELECT v FROM t");
    expect(rows).toEqual([{ v: "hello" }]);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      queryWithSignal(controller.signal, () => db.all("SELECT v FROM t")),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("drops a queued read when its request aborts, and later reads still run", async () => {
    const slow = db.all<{ n: number }>(SLOW_QUERY);

    const aborted = new AbortController();
    const abortedQuery = queryWithSignal(aborted.signal, () => db.all("SELECT v FROM t"));
    const survivor = db.all<{ v: string }>("SELECT v FROM t");

    aborted.abort();

    // The aborted query rejects without waiting for the slow query to finish.
    await expect(abortedQuery).rejects.toMatchObject({ name: "AbortError" });

    await expect(survivor).resolves.toEqual([{ v: "hello" }]);
    await expect(slow).resolves.toEqual([{ n: SLOW_QUERY_ROWS }]);
  }, SLOW_TEST_TIMEOUT_MS);

  it("unblocks the caller when the running read aborts, then continues the queue", async () => {
    const running = new AbortController();
    const runningQuery = queryWithSignal(running.signal, () => db.all(SLOW_QUERY));
    // Give the slow query time to be dispatched to the worker.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const next = db.all<{ v: string }>("SELECT v FROM t");

    running.abort();
    await expect(runningQuery).rejects.toMatchObject({ name: "AbortError" });
    await expect(next).resolves.toEqual([{ v: "hello" }]);
  }, SLOW_TEST_TIMEOUT_MS);
});

describe("AsyncSqlite read worker pool", () => {
  it("lets a fast read overtake a slow one when the pool has capacity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "async-sqlite-pool-spec-"));
    const db = await AsyncSqlite.open(join(dir, "test.db"), { readPoolSize: 2 });
    try {
      await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
      await db.run("INSERT INTO t (v) VALUES (?)", "hello");

      const slow = db.all<{ n: number }>(SLOW_QUERY);
      const fast = db.all<{ v: string }>("SELECT v FROM t");
      const winner = await Promise.race([
        slow.then(() => "slow"),
        fast.then(() => "fast"),
      ]);
      expect(winner).toBe("fast");
      await expect(slow).resolves.toEqual([{ n: SLOW_QUERY_ROWS }]);
    } finally {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, SLOW_TEST_TIMEOUT_MS);
});

describe("AsyncSqlite worker death", () => {
  it("fails every later query instead of hanging, and reports it once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "async-sqlite-death-spec-"));
    const db = await AsyncSqlite.open(join(dir, "test.db"), { readPoolSize: 1 });
    try {
      await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
      const failures: Error[] = [];
      db.onFailure((error) => failures.push(error));

      const internals = db as unknown as { readWorkers: Array<{ terminate(): Promise<number> }> };
      await internals.readWorkers[0].terminate();

      expect(db.failed).toBeInstanceOf(Error);
      await expect(db.all("SELECT v FROM t")).rejects.toThrow(/worker exited/);
      await expect(db.run("INSERT INTO t (v) VALUES (?)", "x")).rejects.toThrow(/worker exited/);
      expect(failures).toHaveLength(1);
    } finally {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
