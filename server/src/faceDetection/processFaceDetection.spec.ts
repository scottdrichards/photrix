import { afterEach, describe, expect, it, jest } from "@jest/globals";
import path from "node:path";
import os from "node:os";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import type { DetectFaces, DetectedFace } from "./faceDetector.type.ts";
import { processFaceDetection } from "./processFaceDetection.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const createDeferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const makeFace = (confidence = 0.9): DetectedFace => ({
  box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
  confidence,
  embedding: new Float64Array(128),
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("processFaceDetection", () => {
  it("detects per file and persists results (including empty/error)", async () => {
    const detectFaces = jest
      .fn<DetectFaces>()
      .mockResolvedValueOnce([makeFace(0.95)])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("decode failure"));

    const saves: Array<{ relativePath: string; faces: DetectedFace[] }> = [];
    const regionWrites: Array<{ relativePath: string; regions: unknown }> = [];
    const failureWrites: Array<{ relativePath: string; facesLastErrorAt?: string }> = [];
    let callCount = 0;
    const db = {
      storagePath: path.join(os.tmpdir(), "photrix-face-test"),
      getFilesNeedingMetadataUpdate: jest.fn((group: string, limit: number) => {
        expect(group).toBe("faces");
        expect(limit).toBe(50);
        callCount += 1;
        if (callCount === 1) {
          return [
            { relativePath: "with-face.jpg" },
            { relativePath: "no-face.jpg" },
            { relativePath: "bad.jpg" },
          ];
        }
        return [];
      }),
      saveFaceDetectionResult: jest.fn(
        async (relativePath: string, faces: DetectedFace[]) => {
          saves.push({ relativePath, faces });
        },
      ),
      addOrUpdateFileData: jest.fn(
        async (relativePath: string, data: { regions?: unknown }) => {
          regionWrites.push({ relativePath, regions: data.regions });
          if ("facesLastErrorAt" in data) {
            failureWrites.push({
              relativePath,
              facesLastErrorAt: data.facesLastErrorAt,
            });
          }
        },
      ),
    } as unknown as IndexDatabase;

    const runner = processFaceDetection(db, detectFaces);
    await runner.onComplete();

    expect(detectFaces).toHaveBeenCalledTimes(3);

    const byPath = Object.fromEntries(saves.map((s) => [s.relativePath, s.faces]));
    expect(byPath["with-face.jpg"]).toHaveLength(1);
    expect(byPath["with-face.jpg"]?.[0]?.confidence).toBe(0.95);
    expect(byPath["no-face.jpg"]).toEqual([]);
    expect(byPath["bad.jpg"]).toBeUndefined();
    expect(failureWrites).toHaveLength(1);
    expect(failureWrites[0]?.relativePath).toBe("bad.jpg");
    expect(failureWrites[0]?.facesLastErrorAt).toEqual(expect.any(String));

    const withFaceRegions = regionWrites.find(
      (entry) => entry.relativePath === "with-face.jpg",
    )?.regions as Array<{
      area: { x: number; y: number; width: number; height: number };
    }>;
    expect(withFaceRegions).toHaveLength(1);
    expect(withFaceRegions[0]?.area).toEqual({
      x: 0.2,
      y: 0.2,
      width: 0.2,
      height: 0.2,
    });
    expect(
      regionWrites.find((entry) => entry.relativePath === "no-face.jpg")?.regions,
    ).toEqual([]);
    expect(
      regionWrites.find((entry) => entry.relativePath === "bad.jpg")?.regions,
    ).toBeUndefined();
  });

  it("calls detect with the full path joined from storagePath and the relative path", async () => {
    const detectFaces = jest.fn<DetectFaces>(async () => []);

    let callCount = 0;
    const storagePath = path.join(os.tmpdir(), "photrix-face-path-test");
    const db = {
      storagePath,
      getFilesNeedingMetadataUpdate: () => {
        callCount += 1;
        return callCount === 1 ? [{ relativePath: "/sub/photo.jpg" }] : [];
      },
      saveFaceDetectionResult: async () => {},
      addOrUpdateFileData: async () => {},
    } as unknown as IndexDatabase;

    const runner = processFaceDetection(db, detectFaces);
    await runner.onComplete();

    expect(detectFaces).toHaveBeenCalledTimes(1);
    const argPath = (detectFaces.mock.calls[0] as [string])[0];
    // Leading slash must be stripped before joining.
    expect(argPath).toBe(path.join(storagePath, "sub", "photo.jpg"));
  });

  it("supports pause/resume", async () => {
    const gate = createDeferred();
    let processedFiles = 0;

    const detectFaces: DetectFaces = async () => {
      processedFiles += 1;
      await gate.promise;
      return [];
    };

    let called = false;
    const db = {
      storagePath: path.join(os.tmpdir(), "photrix-face-pause-test"),
      getFilesNeedingMetadataUpdate: () => {
        if (called) return [];
        called = true;
        return Array.from({ length: 5 }, (_, i) => ({
          relativePath: `f${i}.jpg`,
        }));
      },
      saveFaceDetectionResult: async () => {},
      addOrUpdateFileData: async () => {},
    } as unknown as IndexDatabase;

    const runner = processFaceDetection(db, detectFaces);
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
    const detectFaces: DetectFaces = async () => {
      await gate.promise;
      return [];
    };

    const db = {
      storagePath: path.join(os.tmpdir(), "photrix-face-cancel-test"),
      getFilesNeedingMetadataUpdate: () => [
        { relativePath: "a.jpg" },
        { relativePath: "b.jpg" },
      ],
      saveFaceDetectionResult: async () => {},
      addOrUpdateFileData: async () => {},
    } as unknown as IndexDatabase;

    const runner = processFaceDetection(db, detectFaces);
    await wait(10);
    runner.cancel?.();
    gate.resolve();
    await expect(runner.onComplete()).rejects.toThrow("cancelled");
  });

  it("reports progress based on imageEntries minus missingFaceDetection", async () => {
    const detectFaces: DetectFaces = async () => [];

    let callCount = 0;
    let missingFaceDetection = 2;
    const db = {
      storagePath: path.join(os.tmpdir(), "photrix-face-status-test"),
      getStatusCounts: async () => ({
        allEntries: 10,
        imageEntries: 8,
        videoEntries: 2,
        missingFileMetadata: 0,
        missingMediaMetadata: 0,
        missingThumbnails: 0,
        missingFaceDetection,
      }),
      getFilesNeedingMetadataUpdate: () => {
        callCount += 1;
        if (callCount === 1) {
          return [{ relativePath: "a.jpg" }, { relativePath: "b.jpg" }];
        }
        return [];
      },
      saveFaceDetectionResult: async () => {
        missingFaceDetection = Math.max(0, missingFaceDetection - 1);
      },
      addOrUpdateFileData: async () => {},
    } as unknown as IndexDatabase;

    const runner = processFaceDetection(db, detectFaces);
    await runner.onComplete();

    await expect(runner.getStatus?.()).resolves.toMatchObject({
      state: "complete",
      itemsProcessed: 8,
      total: 8,
      portionComplete: 1,
    });
  });
});
