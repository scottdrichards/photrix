import { afterEach, describe, expect, it, jest } from "@jest/globals";
import path from "node:path";
import os from "node:os";
import type { IndexDatabase } from "./indexDatabase.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  jest.resetModules();
  jest.restoreAllMocks();
});

describe("processExifMetadata", () => {
  it("reports inactive by default", async () => {
    const { isExifMetadataProcessingActive } = await import("./processExifMetadata.ts");
    expect(isExifMetadataProcessingActive()).toBe(false);
  });

  it("processes files, marks failures, and completes", async () => {
    const getExifMetadataFromFile = jest
      .fn()
      .mockResolvedValueOnce({ cameraMake: "Canon" })
      .mockRejectedValueOnce(new Error("bad metadata"));

    jest.unstable_mockModule("../fileHandling/fileUtils.ts", () => ({
      getExifMetadataFromFile,
    }));

    const updates: Array<{ relativePath: string; data: Record<string, unknown> }> = [];
    let callCount = 0;
    const db = {
      storagePath: path.join(os.tmpdir(), "photrix-exif-test"),
      countFilesNeedingMetadataUpdate: () => 3,
      getFilesNeedingMetadataUpdate: () => {
        callCount += 1;
        if (callCount === 1) {
          return [
            { relativePath: "good.jpg", sizeInBytes: 100 },
            { relativePath: "zero.jpg", sizeInBytes: 0 },
            { relativePath: "bad.jpg", sizeInBytes: 100 },
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
    } as unknown as IndexDatabase;

    const {
      processExifMetadata: startBackgroundProcessExifMetadata,
      isExifMetadataProcessingActive,
    } = await import("./processExifMetadata.ts");

    let completed = false;
    startBackgroundProcessExifMetadata(
      db,
      () => Promise.resolve(),
      () => {
        completed = true;
      },
    );

    await wait(50);

    expect(completed).toBe(true);
    expect(isExifMetadataProcessingActive()).toBe(false);
    expect(getExifMetadataFromFile).toHaveBeenCalledTimes(2);

    const byPath = Object.fromEntries(updates.map((u) => [u.relativePath, u.data]));
    expect(byPath["good.jpg"]?.cameraMake).toBe("Canon");
    expect(typeof byPath["good.jpg"]?.exifProcessedAt).toBe("string");
    expect(typeof byPath["zero.jpg"]?.exifProcessedAt).toBe("string");
    expect(typeof byPath["bad.jpg"]?.exifProcessedAt).toBe("string");
  });

  it("returns early if a second run starts while processing is active", async () => {
    const gate = {
      promise: Promise.resolve(),
    };

    const getExifMetadataFromFile = jest.fn(() => gate.promise);

    jest.unstable_mockModule("../fileHandling/fileUtils.ts", () => ({
      getExifMetadataFromFile,
    }));

    const db = {
      storagePath: path.join(os.tmpdir(), "photrix-exif-test-busy"),
      countFilesNeedingMetadataUpdate: () => 1,
      getFilesNeedingMetadataUpdate: (() => {
        let called = false;
        return () => {
          if (called) {
            return [];
          }
          called = true;
          return [{ relativePath: "one.jpg", sizeInBytes: 100 }];
        };
      })(),
      addOrUpdateFileData: async () => undefined,
    } as unknown as IndexDatabase;

    const { processExifMetadata: startBackgroundProcessExifMetadata } = await import(
      "./processExifMetadata.ts"
    );

    const firstRun = startBackgroundProcessExifMetadata(db, () => Promise.resolve());

    await expect(
      startBackgroundProcessExifMetadata(db, () => Promise.resolve()),
    ).resolves.toBeUndefined();

    await firstRun;
  });
});
