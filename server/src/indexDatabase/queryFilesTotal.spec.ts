import { describe, it, expect } from "@jest/globals";
import type { FileRecord } from "./fileRecord.type.ts";
import { splitPath } from "./utils/pathUtils.ts";
import { withTempDb } from "./withTempDb.fixture.ts";

const createRecord = (
  relativePath: string,
  overrides: Partial<FileRecord> = {},
): FileRecord => {
  const { folder, fileName } = splitPath(relativePath);
  return { folder, fileName, mimeType: "image/jpeg", ...overrides };
};

const everything = { folder: { folder: "/", recursive: true } };
const metadata: Array<keyof FileRecord> = ["mimeType"];

describe("queryFiles total", () => {
  it("follows every write, although totals are cached between writes", async () => {
    await withTempDb(async (db) => {
      const total = async (filter: object = everything) =>
        (await db.queryFiles({ filter, metadata, pageSize: 2, page: 1 })).total;

      for (const name of ["a", "b", "c"]) await db.addFile(createRecord(`${name}.jpg`));
      expect(await total()).toBe(3);
      expect(await total()).toBe(3);

      await db.addFile(createRecord("d.jpg"));
      expect(await total()).toBe(4);

      await db.removeFile("a.jpg");
      expect(await total()).toBe(3);

      const fourStars = { rating: { min: 4 } };
      expect(await total(fourStars)).toBe(0);
      await db.updateUserMetadata("b.jpg", { rating: 5 });
      await db.updateUserMetadata("c.jpg", { rating: 4 });
      await db.updateUserMetadata("d.jpg", { rating: 4 });
      expect(await total(fourStars)).toBe(3);
      await db.updateUserMetadata("b.jpg", { rating: 1 });
      expect(await total(fourStars)).toBe(2);
      // The unfiltered total was cached before those rating writes too.
      expect(await total()).toBe(3);
    });
  });

  it("reports the same total on every page, a short last page included", async () => {
    await withTempDb(async (db) => {
      for (let i = 0; i < 5; i += 1) await db.addFile(createRecord(`photo-${i}.jpg`));
      const page = (n: number, pageSize = 2) =>
        db.queryFiles({ filter: everything, metadata, pageSize, page: n });

      const pages = await Promise.all([page(1), page(2), page(3), page(4)]);
      expect(pages.map((p) => p.items.length)).toEqual([2, 2, 1, 0]);
      expect(pages.map((p) => p.total)).toEqual([5, 5, 5, 5]);

      // One page that holds everything, and one that is exactly full.
      expect((await page(1, 50)).total).toBe(5);
      expect((await page(1, 5)).total).toBe(5);
      // A count-only query asks for no rows at all.
      expect((await page(1, 0)).total).toBe(5);
    });
  });

  it("counts an empty result as zero", async () => {
    await withTempDb(async (db) => {
      const result = await db.queryFiles({ filter: everything, metadata, pageSize: 10, page: 1 });
      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
    });
  });

  it("keeps totals for different filters apart", async () => {
    await withTempDb(async (db) => {
      await db.addFile(createRecord("trip/one.jpg"));
      await db.addFile(createRecord("trip/two.jpg"));
      await db.addFile(createRecord("home/three.jpg"));
      const total = async (folder: string) =>
        (
          await db.queryFiles({
            filter: { folder: { folder, recursive: true } },
            metadata,
            pageSize: 1,
            page: 1,
          })
        ).total;
      expect(await total("/trip/")).toBe(2);
      expect(await total("/home/")).toBe(1);
      expect(await total("/trip/")).toBe(2);
      expect(await total("/")).toBe(3);
    });
  });
});

describe("queryFaceClusters", () => {
  it("follows writes, although the People list is cached between them", async () => {
    await withTempDb(async (db) => {
      const embedding = new Float64Array(128);
      embedding[0] = 1;
      const addFace = async (path: string) => {
        await db.addFile(createRecord(path, { dimensionsWidth: 2000 }));
        await db.faces.saveFaceDetectionResult(path, [
          { box: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 }, confidence: 0.9, embedding },
        ]);
      };
      const people = () => db.faceClusters.queryFaceClusters({ filter: {} });

      await addFace("people/one.jpg");
      await addFace("people/two.jpg");
      const first = await people();
      expect(first.clusters.map((cluster) => cluster.count)).toEqual([2]);
      // No write in between: the very same result comes back.
      expect(await people()).toBe(first);

      await addFace("people/three.jpg");
      expect((await people()).clusters.map((cluster) => cluster.count)).toEqual([3]);

      // A filtered list is cached under its own key.
      const inFolder = await db.faceClusters.queryFaceClusters({
        filter: { folder: { folder: "/elsewhere/", recursive: true } },
      });
      expect(inFolder.clusters).toEqual([]);
      expect((await people()).clusters.map((cluster) => cluster.count)).toEqual([3]);
    });
  });
});

describe("cached aggregates", () => {
  it("folder lists, the date range and the date histogram follow writes", async () => {
    await withTempDb(async (db) => {
      const day = (n: number) => new Date(Date.UTC(2024, 0, n));
      // dateTaken belongs to the EXIF group: it is only stored with its stamp.
      const taken = (n: number) => ({ dateTaken: day(n), exifProcessedAt: new Date() });
      await db.addFile(createRecord("trip/one.jpg", taken(1)));
      await db.addFile(createRecord("trip/two.jpg", taken(3)));

      expect(await db.getFolders("/")).toEqual([{ name: "trip", count: 2 }]);
      expect((await db.getDateRange({})).maxDate).toEqual(day(3));
      const histogramTotal = async () =>
        (await db.getDateHistogram({})).buckets.reduce((sum, bucket) => sum + bucket.count, 0);
      expect(await histogramTotal()).toBe(2);

      await db.addFile(createRecord("home/three.jpg", taken(9)));

      expect(await db.getFolders("/")).toEqual([
        { name: "home", count: 1 },
        { name: "trip", count: 2 },
      ]);
      expect((await db.getDateRange({})).maxDate).toEqual(day(9));
      expect(await histogramTotal()).toBe(3);
      // Different arguments are different entries.
      expect(await db.getFolders("/trip/")).toEqual([]);
      expect((await db.getDateHistogram({}, 12)).buckets.length).toBeLessThanOrEqual(12);
    });
  });
});
