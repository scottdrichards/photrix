import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { mkdir, mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";

// The cache root is resolved from CACHE_DIR at import time, so it must be set
// before the module under test (and cacheUtils behind it) is loaded.
let tempRoot: string;
let mod: typeof import("./thumbnailBackfill.ts");
let cachePath: typeof import("../common/cacheUtils.ts").getMirroredCachedFilePath;

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "photrix-backfill-"));
  process.env.CACHE_DIR = tempRoot;
  mod = await import("./thumbnailBackfill.ts");
  ({ getMirroredCachedFilePath: cachePath } = await import("../common/cacheUtils.ts"));
});

afterAll(() => {
  delete process.env.CACHE_DIR;
});

const touch = async (filePath: string) => {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, "x");
};

describe("readThumbnailBackfillConfig", () => {
  it("defaults to 10 MB/s, waiting while load is above half the CPUs", () => {
    expect(mod.readThumbnailBackfillConfig({})).toEqual({
      enabled: true,
      bytesPerSecond: 10 * 1024 * 1024,
      maxLoad: 0.5,
    });
  });

  it("honours overrides and falls back on bad values", () => {
    expect(
      mod.readThumbnailBackfillConfig({
        PHOTRIX_THUMBNAIL_BACKFILL: "0",
        PHOTRIX_THUMBNAIL_BACKFILL_MB_PER_SEC: "25",
        PHOTRIX_THUMBNAIL_BACKFILL_MAX_LOAD: "-1",
      }),
    ).toEqual({ enabled: false, bytesPerSecond: 25 * 1024 * 1024, maxLoad: 0.5 });
  });
});

describe("restAfter", () => {
  it("rests as long as the work took, within a bound", () => {
    expect(mod.restAfter(300)).toBe(300);
    expect(mod.restAfter(-5)).toBe(0);
    expect(mod.restAfter(60_000)).toBe(10_000);
  });
});

describe("createReadPacer", () => {
  it("spaces reads so they average out to the rate", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const pace = mod.createReadPacer(
      1000,
      () => clock,
      async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    );
    await pace(500); // free: nothing read yet
    await pace(2000); // waits out the first 500 bytes = 0.5 s
    await pace(100); // waits out 2000 bytes = 2 s
    expect(sleeps).toEqual([500, 2000]);
  });

  it("does not bank credit while idle", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const pace = mod.createReadPacer(
      1000,
      () => clock,
      async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    );
    await pace(1000);
    clock += 60_000; // a long pause for a user request
    await pace(1000);
    await pace(1000);
    expect(sleeps).toEqual([1000]);
  });
});

describe("planThumbnailWork", () => {
  it("skips a photo once its 320 and either micro tile exist", async () => {
    const photo = join(tempRoot, "library", "a.jpg");
    expect(await mod.planThumbnailWork(photo, "image/jpeg", 4_000_000)).toMatchObject({
      readBytes: 4_000_000,
    });

    await touch(cachePath(photo, 320, "webp"));
    expect(await mod.planThumbnailWork(photo, "image/jpeg", 4_000_000)).not.toBeNull();

    await touch(cachePath(photo, "160.micro2", "webp"));
    expect(await mod.planThumbnailWork(photo, "image/jpeg", 4_000_000)).toBeNull();
  });

  it("accepts a decoded 160 as the micro tile", async () => {
    const photo = join(tempRoot, "library", "b.heic");
    await touch(cachePath(photo, 320, "webp"));
    await touch(cachePath(photo, 160, "webp"));
    expect(await mod.planThumbnailWork(photo, "image/heic", null)).toBeNull();
  });

  it("needs only the 320 frame for a video, charged as a partial read", async () => {
    const video = join(tempRoot, "library", "c.mp4");
    const work = await mod.planThumbnailWork(video, "video/mp4", 2_000_000_000);
    expect(work?.readBytes).toBe(8 * 1024 * 1024);

    await touch(cachePath(video, 320, "jpg"));
    expect(await mod.planThumbnailWork(video, "video/mp4", 2_000_000_000)).toBeNull();
  });
});

describe("processThumbnailBackfill", () => {
  type Candidate = { relativePath: string; mimeType: string; sizeInBytes: number | null };

  // Videos whose 320 frame is already cached: the pass checks them and moves
  // on without touching a converter, which keeps these tests to the loop itself.
  const cachedVideo = async (name: string): Promise<Candidate> => {
    await touch(cachePath(join(tempRoot, "library", name), 320, "jpg"));
    return { relativePath: `/${name}`, mimeType: "video/mp4", sizeInBytes: null };
  };

  const fakeClock = () => {
    let clock = 0;
    const sleeps: number[] = [];
    return {
      sleeps,
      now: () => clock,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
    };
  };

  const fakeDatabase = (lists: Candidate[][]) => {
    let calls = 0;
    const database = {
      storagePath: join(tempRoot, "library"),
      getThumbnailBackfillCandidates: async () =>
        lists[Math.min(calls++, lists.length - 1)],
    } as unknown as import("../indexDatabase/indexDatabase.ts").IndexDatabase;
    return { database, calls: () => calls };
  };

  const config = { enabled: true, bytesPerSecond: 1e9, maxLoad: 0.5 };

  it("waits while the machine is busy", async () => {
    const clock = fakeClock();
    const loads = [0.9, 0.8, 0.2];
    const { database } = fakeDatabase([[await cachedVideo("busy.mp4")]]);
    const runner = mod.processThumbnailBackfill(database, config, {
      ...clock,
      getLoad: () => loads.shift() ?? 0,
    });
    await runner.onComplete();
    expect(clock.sleeps).toEqual([5_000, 5_000]);
    expect(await runner.getStatus?.()).toMatchObject({
      itemsProcessed: 1,
      total: 1,
      description: "Up to date (0 made)",
    });
  });

  it("re-reads the list mid-pass so new files are not left for the next one", async () => {
    const clock = fakeClock();
    const [a, b, added] = [
      await cachedVideo("a.mp4"),
      await cachedVideo("b.mp4"),
      await cachedVideo("added.mp4"),
    ];
    const { database, calls } = fakeDatabase([
      [a, b],
      [added, a, b],
    ]);
    // Busy until eleven minutes in, so the refresh is due by the second file.
    const runner = mod.processThumbnailBackfill(database, config, {
      ...clock,
      getLoad: () => (clock.now() < 11 * 60_000 ? 1 : 0),
    });
    await runner.onComplete();
    expect(calls()).toBe(2);
    expect(await runner.getStatus?.()).toMatchObject({ itemsProcessed: 3, total: 3 });
  });

  it("does nothing when disabled", async () => {
    const { database, calls } = fakeDatabase([[]]);
    const runner = mod.processThumbnailBackfill(database, { ...config, enabled: false });
    await runner.onComplete();
    expect(calls()).toBe(0);
  });
});
