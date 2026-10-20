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

describe("parseHourWindow", () => {
  it("parses same-day and wrapping windows", () => {
    expect(mod.parseHourWindow("1-7")).toEqual({ startHour: 1, endHour: 7 });
    expect(mod.parseHourWindow("22-6")).toEqual({ startHour: 22, endHour: 6 });
    expect(mod.parseHourWindow("22-24")).toEqual({ startHour: 22, endHour: 0 });
  });

  it("treats 0-24 as any hour and rejects nonsense", () => {
    expect(mod.parseHourWindow("0-24")).toBeNull();
    expect(mod.parseHourWindow("5-5")).toBeUndefined();
    expect(mod.parseHourWindow("25-3")).toBeUndefined();
    expect(mod.parseHourWindow("night")).toBeUndefined();
  });
});

describe("isWithinWindow", () => {
  const at = (iso: string) => new Date(iso);

  it("reads the hour in the configured zone", () => {
    const window = { startHour: 1, endHour: 7 };
    // 20:30 UTC is 05:30 in Tokyo — inside; 23:00 UTC is 08:00 — outside.
    expect(mod.isWithinWindow(at("2026-10-20T20:30:00Z"), window, "Asia/Tokyo")).toBe(
      true,
    );
    expect(mod.isWithinWindow(at("2026-10-20T23:00:00Z"), window, "Asia/Tokyo")).toBe(
      false,
    );
    expect(mod.isWithinWindow(at("2026-10-20T06:30:00Z"), window, "UTC")).toBe(true);
    expect(mod.isWithinWindow(at("2026-10-20T07:00:00Z"), window, "UTC")).toBe(false);
  });

  it("handles windows that wrap midnight", () => {
    const window = { startHour: 22, endHour: 6 };
    expect(mod.isWithinWindow(at("2026-10-20T23:00:00Z"), window, "UTC")).toBe(true);
    expect(mod.isWithinWindow(at("2026-10-20T03:00:00Z"), window, "UTC")).toBe(true);
    expect(mod.isWithinWindow(at("2026-10-20T12:00:00Z"), window, "UTC")).toBe(false);
  });

  it("is always open without a window", () => {
    expect(mod.isWithinWindow(new Date(), null, undefined)).toBe(true);
  });
});

describe("msUntilWindowOpens", () => {
  const window = { startHour: 1, endHour: 7 };

  it("counts to the next opening", () => {
    expect(mod.msUntilWindowOpens(new Date("2026-10-20T23:30:00Z"), window, "UTC")).toBe(
      90 * 60_000,
    );
  });

  it("points at tomorrow once today's opening has passed or is now", () => {
    expect(mod.msUntilWindowOpens(new Date("2026-10-20T01:00:00Z"), window, "UTC")).toBe(
      24 * 60 * 60_000,
    );
    expect(mod.msUntilWindowOpens(new Date("2026-10-20T03:00:00Z"), window, "UTC")).toBe(
      22 * 60 * 60_000,
    );
  });
});

describe("readThumbnailBackfillConfig", () => {
  it("defaults to 1–7 AM at 25 MB/s", () => {
    const config = mod.readThumbnailBackfillConfig({});
    expect(config).toEqual({
      enabled: true,
      window: { startHour: 1, endHour: 7 },
      timeZone: undefined,
      bytesPerSecond: 25 * 1024 * 1024,
    });
  });

  it("honours overrides and falls back on bad values", () => {
    const config = mod.readThumbnailBackfillConfig({
      PHOTRIX_THUMBNAIL_BACKFILL: "0",
      PHOTRIX_THUMBNAIL_BACKFILL_HOURS: "0-24",
      PHOTRIX_THUMBNAIL_BACKFILL_TZ: "Not/AZone",
      PHOTRIX_THUMBNAIL_BACKFILL_MB_PER_SEC: "10",
    });
    expect(config).toEqual({
      enabled: false,
      window: null,
      timeZone: undefined,
      bytesPerSecond: 10 * 1024 * 1024,
    });
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
