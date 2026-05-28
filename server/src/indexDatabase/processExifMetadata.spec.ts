import { afterEach, describe, expect, it, jest } from "@jest/globals";
import path from "node:path";
import os from "node:os";
import type { IndexDatabase } from "./indexDatabase.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  jest.resetModules();
  jest.restoreAllMocks();
});

const createDeferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe("processExifMetadata", () => {
  it("processes files and completes", async () => {
    const getExifMetadataFromFile = jest
      .fn()
      .mockResolvedValueOnce({
        cameraMake: "Canon",
        regions: [
          {
            name: "Scott",
            area: { x: 0.5, y: 0.5, width: 0.2, height: 0.2 },
          },
        ],
      })
      .mockRejectedValueOnce(new Error("bad metadata"))
      .mockResolvedValueOnce({ focalLength: 35 });

    jest.unstable_mockModule("../fileHandling/fileUtils.ts", () => ({
      getExifMetadataFromFile,
    }));

    const updates: Array<{ relativePath: string; data: Record<string, unknown> }> = [];
    const metadataFaceWrites: Array<{ relativePath: string; regions: unknown[] }> = [];
    let callCount = 0;
    const db = {
      storagePath: path.join(os.tmpdir(), "photrix-exif-test"),
      getStatusCounts: () => ({
        allEntries: 3,
        imageEntries: 3,
        videoEntries: 0,
        missingFileMetadata: 0,
        missingMediaMetadata: 3,
        missingThumbnails: 0,
      }),
      countFilesNeedingMetadataUpdate: () => 3,
      getFilesNeedingMetadataUpdate: () => {
        callCount += 1;
        if (callCount === 1) {
          return [
            { relativePath: "good.jpg", sizeInBytes: 100 },
            { relativePath: "bad.jpg", sizeInBytes: 100 },
            { relativePath: "ok.jpg", sizeInBytes: 100 },
          ];
        }
        return [];
      },
      addOrUpdateFileData: async (
        relativePath: string,
        data: Record<string, unknown>,
      ) => {
        updates.push({ relativePath, data });
      },
      saveFacesFromMetadataRegions: async (
        relativePath: string,
        regions: unknown[],
      ) => {
        metadataFaceWrites.push({ relativePath, regions });
      },
    } as unknown as IndexDatabase;

    const { processExifMetadata } = await import("./processExifMetadata.ts");

    const runner = processExifMetadata(db);
    await runner.onComplete();

    expect(getExifMetadataFromFile).toHaveBeenCalledTimes(3);

    const byPath = Object.fromEntries(updates.map((u) => [u.relativePath, u.data]));
    expect(byPath["good.jpg"]?.cameraMake).toBe("Canon");
    expect(typeof byPath["good.jpg"]?.exifProcessedAt).toBe("string");
    expect(typeof byPath["bad.jpg"]?.exifProcessedAt).toBe("string");
    expect(byPath["ok.jpg"]?.focalLength).toBe(35);
    expect(metadataFaceWrites).toHaveLength(1);
    expect(metadataFaceWrites[0]?.relativePath).toBe("good.jpg");
  });

  it("supports pause and resume during processing", async () => {
    const gate = createDeferred();
    let processedFiles = 0;

    const getExifMetadataFromFile = jest.fn(async () => {
      processedFiles += 1;
      await gate.promise;
      return { cameraMake: "Canon" };
    });

    jest.unstable_mockModule("../fileHandling/fileUtils.ts", () => ({
      getExifMetadataFromFile,
    }));

    const db = {
      storagePath: path.join(os.tmpdir(), "photrix-exif-pause-test"),
      getStatusCounts: () => ({
        allEntries: 5,
        imageEntries: 5,
        videoEntries: 0,
        missingFileMetadata: 0,
        missingMediaMetadata: 5,
        missingThumbnails: 0,
      }),
      countFilesNeedingMetadataUpdate: () => 5,
      getFilesNeedingMetadataUpdate: (() => {
        let called = false;
        return () => {
          if (called) return [];
          called = true;
          return Array.from({ length: 5 }, (_, i) => ({
            relativePath: `file${i}.jpg`,
            sizeInBytes: 100,
          }));
        };
      })(),
      addOrUpdateFileData: async () => undefined,
      saveFacesFromMetadataRegions: async () => undefined,
    } as unknown as IndexDatabase;

    const { processExifMetadata } = await import("./processExifMetadata.ts");

    const runner = processExifMetadata(db);
    await wait(20);
    runner.pause?.();
    const initialCount = processedFiles;
    await wait(20);
    expect(processedFiles).toBe(initialCount);
    await runner.resume?.();
    gate.resolve();
    await runner.onComplete();
    expect(processedFiles).toBe(5);
  });

  it("cancels processing and rejects onComplete", async () => {
    const gate = createDeferred();

    const getExifMetadataFromFile = jest.fn(async () => {
      await gate.promise;
      return { cameraMake: "Canon" };
    });

    jest.unstable_mockModule("../fileHandling/fileUtils.ts", () => ({
      getExifMetadataFromFile,
    }));

    const db = {
      storagePath: path.join(os.tmpdir(), "photrix-exif-cancel-test"),
      getStatusCounts: () => ({
        allEntries: 2,
        imageEntries: 2,
        videoEntries: 0,
        missingFileMetadata: 0,
        missingMediaMetadata: 2,
        missingThumbnails: 0,
      }),
      countFilesNeedingMetadataUpdate: () => 2,
      getFilesNeedingMetadataUpdate: () => [
        { relativePath: "file1.jpg", sizeInBytes: 100 },
        { relativePath: "file2.jpg", sizeInBytes: 100 },
      ],
      addOrUpdateFileData: async () => undefined,
      saveFacesFromMetadataRegions: async () => undefined,
    } as unknown as IndexDatabase;

    const { processExifMetadata } = await import("./processExifMetadata.ts");

    const runner = processExifMetadata(db);
    await wait(10);
    runner.cancel?.();
    gate.resolve();
    await expect(runner.onComplete()).rejects.toThrow("cancelled");
  });

  it("reports progress from persisted baseline done count", async () => {
    const getExifMetadataFromFile = jest.fn(async () => ({ cameraMake: "Canon" }));

    jest.unstable_mockModule("../fileHandling/fileUtils.ts", () => ({
      getExifMetadataFromFile,
    }));

    let callCount = 0;
    let missingMediaMetadata = 2;
    const db = {
      storagePath: path.join(os.tmpdir(), "photrix-exif-baseline-test"),
      getStatusCounts: () => ({
        allEntries: 10,
        imageEntries: 8,
        videoEntries: 2,
        missingFileMetadata: 0,
        missingMediaMetadata,
        missingThumbnails: 0,
      }),
      countFilesNeedingMetadataUpdate: () => 2,
      getFilesNeedingMetadataUpdate: () => {
        callCount += 1;
        if (callCount === 1) {
          return [
            { relativePath: "a.jpg", sizeInBytes: 100 },
            { relativePath: "b.jpg", sizeInBytes: 100 },
          ];
        }
        return [];
      },
      addOrUpdateFileData: async () => {
        missingMediaMetadata = Math.max(0, missingMediaMetadata - 1);
      },
      saveFacesFromMetadataRegions: async () => undefined,
    } as unknown as IndexDatabase;

    const { processExifMetadata } = await import("./processExifMetadata.ts");
    const runner = processExifMetadata(db);
    await runner.onComplete();

    await expect(runner.getStatus?.()).resolves.toMatchObject({
      state: "complete",
      itemsProcessed: 10,
      total: 10,
      portionComplete: 1,
    });
  });
});
