import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { mkdir, mkdtemp, readdir, utimes, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

// MEDIA_CACHE_DIR is resolved from CACHE_DIR at import time, so the cache root
// must be set before the module under test is loaded.
let tempRoot: string;
let mediaDir: string;
let enforceCacheLimit: typeof import("./cacheEviction.ts").enforceCacheLimit;
let parseByteSize: typeof import("./cacheEviction.ts").parseByteSize;

const writeCacheFile = async (name: string, sizeBytes: number, ageMs: number) => {
  const filePath = join(mediaDir, name);
  await writeFile(filePath, Buffer.alloc(sizeBytes, 1));
  const when = new Date(Date.now() - ageMs);
  await utimes(filePath, when, when);
  return filePath;
};

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "photrix-evict-"));
  process.env.CACHE_DIR = tempRoot;
  mediaDir = join(tempRoot, "media");
  await mkdir(mediaDir, { recursive: true });
  ({ enforceCacheLimit, parseByteSize } = await import("./cacheEviction.ts"));
});

afterAll(() => {
  delete process.env.CACHE_DIR;
  delete process.env.CACHE_MAX_BYTES;
});

describe("parseByteSize", () => {
  it("parses plain byte counts", () => {
    expect(parseByteSize("1024")).toBe(1024);
  });

  it("parses suffixed sizes case-insensitively", () => {
    expect(parseByteSize("10GB")).toBe(10 * 1024 ** 3);
    expect(parseByteSize("512mb")).toBe(512 * 1024 ** 2);
  });

  it("returns null for unset or invalid values", () => {
    expect(parseByteSize(undefined)).toBeNull();
    expect(parseByteSize("not-a-size")).toBeNull();
  });
});

describe("enforceCacheLimit", () => {
  it("evicts least-recently-used files until under the limit", async () => {
    // 4 files of 100 bytes each (400 total); limit 250 → target 225.
    await writeCacheFile("oldest.jpg", 100, 40_000);
    await writeCacheFile("older.jpg", 100, 30_000);
    await writeCacheFile("newer.jpg", 100, 20_000);
    await writeCacheFile("newest.jpg", 100, 10_000);
    process.env.CACHE_MAX_BYTES = "250";

    const result = await enforceCacheLimit();

    expect(result.evictedCount).toBe(2);
    expect(result.evictedBytes).toBe(200);

    const remaining = (await readdir(mediaDir)).sort();
    expect(remaining).toEqual(["newer.jpg", "newest.jpg"]);
  });

  it("does nothing when under the limit", async () => {
    process.env.CACHE_MAX_BYTES = "10GB";
    const result = await enforceCacheLimit();
    expect(result.evictedCount).toBe(0);
  });
});
