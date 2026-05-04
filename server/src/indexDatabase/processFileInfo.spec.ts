import { afterEach, describe, expect, it, jest } from "@jest/globals";
import path from "node:path";
import os from "node:os";
import type { IndexDatabase } from "./indexDatabase.ts";

afterEach(() => {
  jest.resetModules();
  jest.restoreAllMocks();
});

describe("processFileInfoMetadata", () => {
  it("writes infoProcessedAt when stat succeeds", async () => {
    const stat = jest.fn().mockResolvedValue({
      size: 123,
      birthtimeMs: new Date("2025-01-01T00:00:00.000Z").getTime(),
      mtimeMs: new Date("2025-01-02T00:00:00.000Z").getTime(),
    });

    jest.unstable_mockModule("node:fs/promises", () => ({ stat }));

    const updates: Array<{ relativePath: string; data: Record<string, unknown> }> = [];
    let callCount = 0;
    const db = {
      storagePath: path.join(os.tmpdir(), "photrix-file-info-test"),
      getStatusCounts: () => ({
        allEntries: 1,
        imageEntries: 1,
        videoEntries: 0,
        missingFileMetadata: 0,
        missingMediaMetadata: 0,
        missingThumbnails: 0,
      }),
      getFilesNeedingMetadataUpdate: () => {
        callCount += 1;
        if (callCount === 1) {
          return [{ relativePath: "a.jpg", sizeInBytes: undefined }];
        }
        return [];
      },
      addOrUpdateFileData: async (
        relativePath: string,
        data: Record<string, unknown>,
      ) => {
        updates.push({ relativePath, data });
      },
      removeFile: async () => undefined,
    } as unknown as IndexDatabase;

    const { processFileInfoMetadata } = await import("./processFileInfo.ts");
    const runner = processFileInfoMetadata(db);
    await runner.onComplete();

    expect(stat).toHaveBeenCalledTimes(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.relativePath).toBe("a.jpg");
    expect(updates[0]?.data).toMatchObject({
      sizeInBytes: 123,
    });
    expect(typeof updates[0]?.data.infoProcessedAt).toBe("string");
  });

  it("marks infoProcessedAt on non-ENOENT stat failure", async () => {
    const stat = jest.fn().mockRejectedValue(Object.assign(new Error("EPERM"), { code: "EPERM" }));

    jest.unstable_mockModule("node:fs/promises", () => ({ stat }));

    const updates: Array<{ relativePath: string; data: Record<string, unknown> }> = [];
    const removed: string[] = [];
    let callCount = 0;
    const db = {
      storagePath: path.join(os.tmpdir(), "photrix-file-info-error-test"),
      getStatusCounts: () => ({
        allEntries: 1,
        imageEntries: 1,
        videoEntries: 0,
        missingFileMetadata: 0,
        missingMediaMetadata: 0,
        missingThumbnails: 0,
      }),
      getFilesNeedingMetadataUpdate: () => {
        callCount += 1;
        if (callCount === 1) {
          return [{ relativePath: "b.jpg", sizeInBytes: undefined }];
        }
        return [];
      },
      addOrUpdateFileData: async (
        relativePath: string,
        data: Record<string, unknown>,
      ) => {
        updates.push({ relativePath, data });
      },
      removeFile: async (relativePath: string) => {
        removed.push(relativePath);
      },
    } as unknown as IndexDatabase;

    const { processFileInfoMetadata } = await import("./processFileInfo.ts");
    const runner = processFileInfoMetadata(db);
    await runner.onComplete();

    expect(stat).toHaveBeenCalledTimes(1);
    expect(removed).toEqual([]);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.relativePath).toBe("b.jpg");
    expect(typeof updates[0]?.data.infoProcessedAt).toBe("string");
  });

  it("removes file on ENOENT", async () => {
    const stat = jest
      .fn()
      .mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

    jest.unstable_mockModule("node:fs/promises", () => ({ stat }));

    const updates: Array<{ relativePath: string; data: Record<string, unknown> }> = [];
    const removed: string[] = [];
    let callCount = 0;
    const db = {
      storagePath: path.join(os.tmpdir(), "photrix-file-info-enoent-test"),
      getStatusCounts: () => ({
        allEntries: 1,
        imageEntries: 1,
        videoEntries: 0,
        missingFileMetadata: 0,
        missingMediaMetadata: 0,
        missingThumbnails: 0,
      }),
      getFilesNeedingMetadataUpdate: () => {
        callCount += 1;
        if (callCount === 1) {
          return [{ relativePath: "c.jpg", sizeInBytes: undefined }];
        }
        return [];
      },
      addOrUpdateFileData: async (
        relativePath: string,
        data: Record<string, unknown>,
      ) => {
        updates.push({ relativePath, data });
      },
      removeFile: async (relativePath: string) => {
        removed.push(relativePath);
      },
    } as unknown as IndexDatabase;

    const { processFileInfoMetadata } = await import("./processFileInfo.ts");
    const runner = processFileInfoMetadata(db);
    await runner.onComplete();

    expect(stat).toHaveBeenCalledTimes(1);
    expect(updates).toEqual([]);
    expect(removed).toEqual(["c.jpg"]);
  });
});
