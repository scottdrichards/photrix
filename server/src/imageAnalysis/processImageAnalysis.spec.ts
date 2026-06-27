import { afterEach, describe, expect, it, jest } from "@jest/globals";
import path from "node:path";
import os from "node:os";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { processImageAnalysis, type AnalyzeImage } from "./processImageAnalysis.ts";
import { PermanentImageError } from "./imageAnalysisWorker.ts";
import type { ImageAnalysisResult } from "./imageAnalysisWorker.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const createDeferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const makeFace = (confidence = 0.9) => ({
  box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
  confidence,
  embedding: new Float64Array(128),
});

type NeedsRow = {
  relativePath: string;
  needsFaces: boolean;
  needsEmbedding: boolean;
};

/** Minimal DB double that serves one batch of rows then drains. */
const makeDb = (
  rows: NeedsRow[],
  overrides: Partial<Record<keyof IndexDatabase, unknown>> = {},
) => {
  let served = false;
  const calls: {
    faceSaves: Array<{ relativePath: string; faces: unknown[] }>;
    regionWrites: Array<{ relativePath: string; data: Record<string, unknown> }>;
    embeddingSaves: Array<{ relativePath: string; embedding: Float32Array }>;
    embeddingErrors: string[];
    decodeErrors: string[];
  } = { faceSaves: [], regionWrites: [], embeddingSaves: [], embeddingErrors: [], decodeErrors: [] };

  const db = {
    storagePath: path.join(os.tmpdir(), "photrix-analysis-test"),
    getImagesNeedingAnalysis: jest.fn(async () => {
      if (served) return [];
      served = true;
      return rows;
    }),
    hasImagesPendingAnalysisPrerequisites: jest.fn(async () => false),
    saveFaceDetectionResult: jest.fn(async (relativePath: string, faces: unknown[]) => {
      calls.faceSaves.push({ relativePath, faces });
    }),
    addOrUpdateFileData: jest.fn(
      async (relativePath: string, data: Record<string, unknown>) => {
        calls.regionWrites.push({ relativePath, data });
      },
    ),
    saveImageEmbedding: jest.fn(
      async (relativePath: string, embedding: Float32Array) => {
        calls.embeddingSaves.push({ relativePath, embedding });
      },
    ),
    saveImageEmbeddingError: jest.fn(async (relativePath: string) => {
      calls.embeddingErrors.push(relativePath);
    }),
    saveImageAnalysisDecodeError: jest.fn(async (relativePath: string) => {
      calls.decodeErrors.push(relativePath);
    }),
    ...overrides,
  } as unknown as IndexDatabase;

  return { db, calls };
};

afterEach(() => {
  jest.restoreAllMocks();
});

describe("processImageAnalysis", () => {
  it("requests only the missing stages and never recomputes stored work", async () => {
    const analyze = jest.fn<AnalyzeImage>(async (_p, { faces, embed }) => {
      const result: ImageAnalysisResult = {};
      if (faces) result.faces = [makeFace(0.95)];
      if (embed) result.embedding = new Float32Array([0.1, 0.2]);
      return result;
    });

    const { db, calls } = makeDb([
      { relativePath: "both.jpg", needsFaces: true, needsEmbedding: true },
      { relativePath: "faces-only.jpg", needsFaces: true, needsEmbedding: false },
      { relativePath: "embed-only.jpg", needsFaces: false, needsEmbedding: true },
    ]);

    await processImageAnalysis(db, analyze).onComplete();

    // Each file is analyzed exactly once, with flags matching its missing parts.
    const byPath = Object.fromEntries(
      analyze.mock.calls.map(([p, opts]) => [path.basename(p), opts]),
    );
    expect(byPath["both.jpg"]).toEqual({ faces: true, embed: true });
    expect(byPath["faces-only.jpg"]).toEqual({ faces: true, embed: false });
    expect(byPath["embed-only.jpg"]).toEqual({ faces: false, embed: true });

    // Faces only persisted where requested.
    expect(calls.faceSaves.map((s) => s.relativePath).sort()).toEqual([
      "both.jpg",
      "faces-only.jpg",
    ]);
    // Embeddings only persisted where requested — no recompute for faces-only.
    expect(calls.embeddingSaves.map((s) => s.relativePath).sort()).toEqual([
      "both.jpg",
      "embed-only.jpg",
    ]);
  });

  it("records per-stage failures independently", async () => {
    const analyze = jest.fn<AnalyzeImage>(async () => ({
      faces: [makeFace()],
      embeddingError: "clip blew up",
    }));

    const { db, calls } = makeDb([
      { relativePath: "partial.jpg", needsFaces: true, needsEmbedding: true },
    ]);

    await processImageAnalysis(db, analyze).onComplete();

    // Faces stored, embedding marked errored — one stage failing doesn't block
    // the other.
    expect(calls.faceSaves).toHaveLength(1);
    expect(calls.embeddingSaves).toHaveLength(0);
    expect(calls.embeddingErrors).toEqual(["partial.jpg"]);
  });

  it("marks a PermanentImageError as a decode error (no retry)", async () => {
    const analyze = jest.fn<AnalyzeImage>(async () => {
      throw new PermanentImageError("image file is truncated");
    });

    const { db, calls } = makeDb([
      { relativePath: "corrupt.jpg", needsFaces: true, needsEmbedding: true },
    ]);

    await processImageAnalysis(db, analyze).onComplete();

    expect(calls.faceSaves).toHaveLength(0);
    expect(calls.embeddingSaves).toHaveLength(0);
    // Permanent decode error recorded — not the per-stage retry error columns.
    expect(calls.decodeErrors).toEqual(["corrupt.jpg"]);
    expect(calls.embeddingErrors).toHaveLength(0);
    expect(calls.regionWrites).toHaveLength(0);
  });

  it("marks every requested stage on a transient (worker) failure for retry", async () => {
    const analyze = jest.fn<AnalyzeImage>(async () => {
      throw new Error("worker timed out");
    });

    const { db, calls } = makeDb([
      { relativePath: "bad.jpg", needsFaces: true, needsEmbedding: true },
    ]);

    await processImageAnalysis(db, analyze).onComplete();

    expect(calls.faceSaves).toHaveLength(0);
    expect(calls.embeddingSaves).toHaveLength(0);
    expect(calls.decodeErrors).toHaveLength(0);
    expect(calls.embeddingErrors).toEqual(["bad.jpg"]);
    const faceError = calls.regionWrites.find(
      (w) => w.relativePath === "bad.jpg" && "facesLastErrorAt" in w.data,
    );
    expect(faceError?.data.facesLastErrorAt).toEqual(expect.any(String));
  });

  it("passes the full path joined from storagePath, stripping the leading slash", async () => {
    const analyze = jest.fn<AnalyzeImage>(async () => ({ embedding: new Float32Array(1) }));
    const { db } = makeDb([
      { relativePath: "/sub/photo.jpg", needsFaces: false, needsEmbedding: true },
    ]);

    await processImageAnalysis(db, analyze).onComplete();

    expect((analyze.mock.calls[0] as [string])[0]).toBe(
      path.join(db.storagePath, "sub", "photo.jpg"),
    );
  });

  it("supports pause/resume", async () => {
    const gate = createDeferred();
    let processed = 0;
    const analyze: AnalyzeImage = async () => {
      processed += 1;
      await gate.promise;
      return {};
    };

    const rows: NeedsRow[] = Array.from({ length: 5 }, (_, i) => ({
      relativePath: `f${i}.jpg`,
      needsFaces: false,
      needsEmbedding: true,
    }));
    const { db } = makeDb(rows);

    const runner = processImageAnalysis(db, analyze);
    await wait(20);
    runner.pause?.();
    const atPause = processed;
    await wait(20);
    expect(processed).toBe(atPause);
    await runner.resume?.();
    gate.resolve();
    await runner.onComplete();
    expect(processed).toBe(5);
  });

  it("cancels processing and rejects onComplete", async () => {
    const gate = createDeferred();
    const analyze: AnalyzeImage = async () => {
      await gate.promise;
      return {};
    };
    const { db } = makeDb([
      { relativePath: "a.jpg", needsFaces: false, needsEmbedding: true },
      { relativePath: "b.jpg", needsFaces: false, needsEmbedding: true },
    ]);

    const runner = processImageAnalysis(db, analyze);
    await wait(10);
    runner.cancel?.();
    gate.resolve();
    await expect(runner.onComplete()).rejects.toThrow("cancelled");
  });

  it("describes which stages remain in its status", async () => {
    const analyze: AnalyzeImage = async () => ({});
    const { db } = makeDb([], {
      getStatusCounts: async () => ({
        allEntries: 10,
        imageEntries: 8,
        videoEntries: 2,
        missingFileMetadata: 0,
        missingMediaMetadata: 0,
        missingThumbnails: 0,
        missingFaceDetection: 3,
      }),
      getEmbeddingProgress: async () => [8, 8] as [number, number],
    });

    const runner = processImageAnalysis(db, analyze);
    await runner.onComplete();

    // Faces still pending, embeddings done -> description names only faces.
    await expect(runner.getStatus?.()).resolves.toMatchObject({
      description: "Processing faces",
      total: 16,
      itemsProcessed: 13,
    });
  });
});
