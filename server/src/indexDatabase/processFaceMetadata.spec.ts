import { afterEach, describe, expect, it, jest } from "@jest/globals";
import path from "node:path";
import os from "node:os";
import type { FileRecord } from "./fileRecord.type.ts";
import type { IndexDatabase } from "./indexDatabase.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (predicate: () => boolean, timeoutMs = 5_000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await wait(20);
  }
};

afterEach(() => {
  jest.resetModules();
  jest.restoreAllMocks();
});

describe("processFaceMetadata", () => {
  it("completes immediately when no files need face metadata", async () => {
    const extractFaceEmbeddingsFromImage = jest.fn(async () => []);
    jest.unstable_mockModule("../imageProcessing/faceEmbedding.ts", () => ({
      extractFaceEmbeddingsFromImage,
    }));
    const { isFaceMetadataProcessingActive, startBackgroundProcessFaceMetadata } =
      await import("./processFaceMetadata.ts");

    let completed = false;

    const database = {
      storagePath: path.join(os.tmpdir(), "photrix-face-empty"),
      countFilesNeedingMetadataUpdate: () => 0,
      getFilesNeedingMetadataUpdate: () => [],
      getFileRecord: async () => undefined,
      addOrUpdateFileData: async () => undefined,
    } as unknown as IndexDatabase;

    const pause = startBackgroundProcessFaceMetadata(database, () => {
      completed = true;
    });

    pause(5);
    await wait(30);

    expect(completed).toBe(true);
    expect(isFaceMetadataProcessingActive()).toBe(false);
  });

  it("seeds known tags, adds quality/thumbnail metadata, and suggests from confirmed profiles", async () => {
    const extractFaceEmbeddingsFromImage = jest.fn(
      async ({ imagePath }: { imagePath: string }) => {
        if (imagePath.includes("a.jpg")) {
          return [
            {
              dimensions: { x: 0.15, y: 0.2, width: 0.25, height: 0.3 },
              embedding: new Array(128).fill(0).map((_, i) => i / 128),
              detector: "opencv-haar",
              quality: { overall: 0.9, sharpness: 0.95, effectiveResolution: 180 },
            },
          ];
        }

        if (imagePath.includes("c.jpg")) {
          return [
            {
              dimensions: { x: 0.15, y: 0.2, width: 0.25, height: 0.3 },
              embedding: new Array(128).fill(0).map((_, i) => i / 128),
              detector: "opencv-haar",
              quality: { overall: 0.85, sharpness: 0.9, effectiveResolution: 170 },
            },
          ];
        }

        return [];
      },
    );
    jest.unstable_mockModule("../imageProcessing/faceEmbedding.ts", () => ({
      extractFaceEmbeddingsFromImage,
    }));
    const { startBackgroundProcessFaceMetadata } = await import(
      "./processFaceMetadata.ts"
    );

    const addOrUpdateFileData = jest.fn(async () => undefined);
    const getFileRecord = jest.fn(
      async (relativePath: string): Promise<FileRecord | undefined> => {
        if (relativePath === "/family/a.jpg") {
          return {
            folder: "/family/",
            fileName: "a.jpg",
            mimeType: "image/jpeg",
            dimensionWidth: 4_000,
            dimensionHeight: 3_000,
            regions: [
              {
                name: "Sam",
                area: { x: 0.15, y: 0.2, width: 0.25, height: 0.3 },
              },
            ],
            personInImage: ["Sam"],
          };
        }

        if (relativePath === "/family/c.jpg") {
          return {
            folder: "/family/",
            fileName: "c.jpg",
            mimeType: "image/jpeg",
            dimensionWidth: 4_000,
            dimensionHeight: 3_000,
            regions: [
              {
                area: { x: 0.15, y: 0.2, width: 0.25, height: 0.3 },
              },
            ],
          };
        }

        return {
          folder: "/family/",
          fileName: "b.jpg",
          mimeType: "image/jpeg",
        };
      },
    );

    let batchRequested = false;
    const database = {
      storagePath: path.join(os.tmpdir(), "photrix-face-seed"),
      countFilesNeedingMetadataUpdate: () => 3,
      getFilesNeedingMetadataUpdate: () => {
        if (batchRequested) {
          return [];
        }
        batchRequested = true;
        return [
          { relativePath: "/family/a.jpg", mimeType: "image/jpeg" },
          { relativePath: "/family/b.jpg", mimeType: "image/jpeg" },
          { relativePath: "/family/c.jpg", mimeType: "image/jpeg" },
        ];
      },
      getFileRecord,
      addOrUpdateFileData,
    } as unknown as IndexDatabase;

    let completed = false;
    startBackgroundProcessFaceMetadata(database, () => {
      completed = true;
    });

    await waitFor(() => completed);

    expect(completed).toBe(true);
    expect(getFileRecord).toHaveBeenCalledWith("/family/a.jpg", [
      "regions",
      "personInImage",
      "dimensionWidth",
      "dimensionHeight",
    ]);
    expect(addOrUpdateFileData).toHaveBeenCalledTimes(3);

    const firstCall = addOrUpdateFileData.mock.calls[0];
    expect(firstCall).toBeDefined();
    const [firstPath, firstPayload] = firstCall as unknown as [string, FileRecord];
    expect(firstPath).toBe("/family/a.jpg");
    expect(Array.isArray(firstPayload.faceTags)).toBe(true);
    expect(firstPayload.faceTags?.[0]).toMatchObject({
      source: "seed-known",
      status: "confirmed",
      person: { name: "Sam" },
      dimensions: { x: 0.15, y: 0.2, width: 0.25, height: 0.3 },
      quality: {
        overall: expect.any(Number),
        sharpness: expect.any(Number),
        effectiveResolution: expect.any(Number),
      },
      thumbnail: { preferredHeight: expect.any(Number), cropVersion: "v1" },
    });
    expect(firstPayload.faceTags?.[0]?.featureDescription).toMatchObject({
      embedding: expect.any(Array),
    });
    expect(typeof firstPayload.faceMetadataProcessedAt).toBe("string");

    const secondCall = addOrUpdateFileData.mock.calls[1];
    expect(secondCall).toBeDefined();
    const [secondPath, secondPayload] = secondCall as unknown as [string, FileRecord];
    expect(secondPath).toBe("/family/b.jpg");
    expect(secondPayload.faceTags).toEqual([]);
    expect(typeof secondPayload.faceMetadataProcessedAt).toBe("string");

    const thirdCall = addOrUpdateFileData.mock.calls[2];
    expect(thirdCall).toBeDefined();
    const [thirdPath, thirdPayload] = thirdCall as unknown as [string, FileRecord];
    expect(thirdPath).toBe("/family/c.jpg");
    expect(thirdPayload.faceTags?.[0]).toMatchObject({
      status: "unverified",
      source: "seed-known",
      suggestion: {
        personId: "name:sam",
        confidence: expect.any(Number),
      },
    });
  });

  it("marks non-image files as face-processed without extraction", async () => {
    const extractFaceEmbeddingsFromImage = jest.fn(async () => []);
    jest.unstable_mockModule("../imageProcessing/faceEmbedding.ts", () => ({
      extractFaceEmbeddingsFromImage,
    }));
    const { startBackgroundProcessFaceMetadata } = await import(
      "./processFaceMetadata.ts"
    );

    const addOrUpdateFileData = jest.fn(async () => undefined);
    const getFileRecord = jest.fn(async () => undefined);

    let batchRequested = false;
    const database = {
      storagePath: path.join(os.tmpdir(), "photrix-face-non-image"),
      countFilesNeedingMetadataUpdate: () => 1,
      getFilesNeedingMetadataUpdate: () => {
        if (batchRequested) {
          return [];
        }
        batchRequested = true;
        return [{ relativePath: "/docs/file.mp4", mimeType: "video/mp4" }];
      },
      getFileRecord,
      addOrUpdateFileData,
    } as unknown as IndexDatabase;

    let completed = false;
    startBackgroundProcessFaceMetadata(database, () => {
      completed = true;
    });

    await waitFor(() => completed);

    expect(getFileRecord).not.toHaveBeenCalled();
    expect(extractFaceEmbeddingsFromImage).not.toHaveBeenCalled();
    expect(addOrUpdateFileData).toHaveBeenCalledWith(
      "/docs/file.mp4",
      expect.objectContaining({
        faceTags: [],
        faceMetadataProcessedAt: expect.any(String),
      }),
    );
  });
});
