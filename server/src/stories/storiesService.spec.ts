import { afterEach, describe, expect, it, jest } from "@jest/globals";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getExifMetadataFromFile, walkFiles } from "../fileHandling/fileUtils.ts";
import { mimeTypeForFilename } from "../fileHandling/mimeTypes.ts";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { splitPath } from "../indexDatabase/utils/pathUtils.ts";
import { withTempDb } from "../indexDatabase/withTempDb.fixture.ts";
import { StoriesService } from "./storiesService.ts";

const EXAMPLE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../exampleFolder",
);

/**
 * Indexes exampleFolder's real image EXIF (dates, GPS) into `db`, the way the
 * pipeline's EXIF stage would. Videos need ffprobe, which the CI unit job
 * lacks, so the one video a story uses is recorded with its known date.
 */
const indexExampleFolder = async (db: IndexDatabase) => {
  const add = async (relative: string, mimeType: string, exif: object) => {
    const { folder, fileName } = splitPath(relative);
    await db.addFile({
      folder,
      fileName,
      mimeType,
      ...exif,
      exifProcessedAt: new Date(),
    } as Parameters<IndexDatabase["addFile"]>[0]);
  };
  for (const fullPath of walkFiles(EXAMPLE_ROOT)) {
    const mimeType = mimeTypeForFilename(fullPath);
    if (!mimeType?.startsWith("image/")) continue;
    const relative = `/${path.relative(EXAMPLE_ROOT, fullPath).split(path.sep).join("/")}`;
    await add(relative, mimeType, await getExifMetadataFromFile(fullPath));
  }
  // Trip/Malibu_2024-06-14.mov: dated, no GPS.
  await add("/Trip/Malibu_2024-06-14.mov", "video/quicktime", {
    dateTaken: new Date(2024, 5, 14, 19, 5),
  });
};

// Each test indexes the whole fixture folder into a fresh database: seconds, not milliseconds.
describe("StoriesService over exampleFolder", () => {
  it("finds the Italy trip and the June 2024 road trip, newest first, and nothing from the Seattle home base", async () => {
    await withTempDb(async (db) => {
      await indexExampleFolder(db);
      const stories = await new StoriesService(db).list();
      expect(
        stories.map(({ id, kicker, title, dayCount }) => ({
          id,
          kicker,
          title,
          dayCount,
        })),
      ).toEqual([
        {
          id: "trip-2024-06-12-2024-06-14",
          kicker: "Trip",
          title: "Arizona, Nevada & California",
          dayCount: 3,
        },
        {
          id: "trip-2023-05-03-2023-05-06",
          kicker: "Trip",
          title: "Rome & Florence",
          dayCount: 4,
        },
      ]);
      const italy = stories[1];
      expect(italy).toMatchObject({
        photoCount: 12,
        videoCount: 0,
        places: ["Rome", "Florence"],
      });
      expect(italy.distanceKm).toBeGreaterThan(450);
      expect(italy.cover.path).toMatch(/^\/Trip\/Italy\//);
      expect(italy.collage).toHaveLength(3);
    });
  }, 30_000);

  it("tells a story as frames in time order with a chapter per day and the route", async () => {
    await withTempDb(async (db) => {
      await indexExampleFolder(db);
      const service = new StoriesService(db);
      const italy = (await service.detail("trip-2023-05-03-2023-05-06"))!;
      expect(italy.frames).toHaveLength(12);
      expect(italy.frames.map(({ localTime }) => localTime)).toEqual(
        [...italy.frames.map(({ localTime }) => localTime)].sort(),
      );
      expect(italy.frames[0]).toMatchObject({
        path: "/Trip/Italy/IMG_5101.jpg",
        localTime: "2023-05-03T14:10:12",
        day: 1,
        place: "Rome",
      });
      expect(italy.chapters.map(({ day, place }) => `${day}:${place}`)).toEqual([
        "1:Rome",
        "2:Rome",
        "3:Florence",
        "4:Rome",
      ]);
      // The Malibu clip has no GPS, but its day is inside the trip, so it counts.
      expect((await service.list())[0]).toMatchObject({ photoCount: 4, videoCount: 1 });
      expect(italy.route.length).toBeGreaterThan(5);
      expect(await service.detail("trip-1999-01-01-1999-01-02")).toBeNull();
    });
  }, 30_000);
});

describe("StoriesService cache", () => {
  afterEach(() => jest.restoreAllMocks());

  it("rebuilds when newly indexed photos change the timeline, but not more than every 30 s", async () => {
    let version = 1;
    let reads = 0;
    const database = {
      getDefaultExclusionFilter: async () => null,
      stories: {
        getTimelineVersion: async () => version,
        getTimeline: async () => {
          reads++;
          return [];
        },
        getFaces: async () => [],
        getImageEmbeddings: async () => new Map(),
      },
    } as unknown as ConstructorParameters<typeof StoriesService>[0];
    let now = 1_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    const service = new StoriesService(database);

    await service.list();
    await service.list();
    expect(reads).toBe(1);
    version = 2;
    now += 10_000;
    await service.list();
    expect(reads).toBe(1);
    now += 25_000;
    await service.list();
    expect(reads).toBe(2);
    now += 11 * 60_000;
    await service.list();
    expect(reads).toBe(3);
  });
});
