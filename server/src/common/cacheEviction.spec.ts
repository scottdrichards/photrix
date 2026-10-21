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

  it("neither counts nor evicts grid thumbnails", async () => {
    // Left from the test above: newer.jpg + newest.jpg = 200 bytes.
    await mkdir(join(mediaDir, "photo"), { recursive: true });
    for (const name of ["160.webp", "160.micro2.webp", "320.webp", "320.jpg"]) {
      await writeCacheFile(join("photo", name), 1000, 90_000);
    }
    await writeCacheFile(join("photo", "2160.webp"), 100, 50_000);
    process.env.CACHE_MAX_BYTES = "250";

    const result = await enforceCacheLimit();

    // 300 evictable bytes against a 225 target: only the full-size view goes,
    // even though all four thumbnails are older and 40x its size together.
    expect(result.evictedCount).toBe(1);
    expect(result.totalBytes).toBe(300);
    expect((await readdir(join(mediaDir, "photo"))).sort()).toEqual([
      "160.micro2.webp",
      "160.webp",
      "320.jpg",
      "320.webp",
    ]);
  });

  it("walks a deep, wide tree and evicts the oldest file anywhere in it", async () => {
    // Left from above: newer.jpg + newest.jpg = 200 evictable bytes.
    for (let a = 0; a < 6; a++) {
      for (let b = 0; b < 6; b++) {
        const dir = join("deep", `a${a}`, `b${b}`, "c", "d");
        await mkdir(join(mediaDir, dir), { recursive: true });
        await writeCacheFile(join(dir, "720.webp"), 10, 5_000);
      }
    }
    const buried = join("deep", "a3", "b2", "c", "d");
    await writeCacheFile(join(buried, "1080.webp"), 10, 900_000);
    // 200 + 36 * 10 + 10 = 570. Limit 560 → target 504: the buried oldest file
    // goes first, then newer.jpg (the next oldest), leaving 460.
    process.env.CACHE_MAX_BYTES = "560";

    const result = await enforceCacheLimit();

    expect(result.totalBytes).toBe(570);
    expect(result.evictedCount).toBe(2);
    expect(await readdir(join(mediaDir, buried))).toEqual(["720.webp"]);
    expect((await readdir(mediaDir)).sort()).toEqual(["deep", "newest.jpg", "photo"]);
  });

  it("does nothing when under the limit", async () => {
    process.env.CACHE_MAX_BYTES = "10GB";
    const result = await enforceCacheLimit();
    expect(result.evictedCount).toBe(0);
  });
});
