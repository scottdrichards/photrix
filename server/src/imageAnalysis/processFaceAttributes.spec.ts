import { describe, expect, it, jest } from "@jest/globals";
import path from "node:path";
import os from "node:os";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import type { FaceAttributes } from "../faceDetection/faceDetector.type.ts";
import {
  processFaceAttributes,
  type AnalyzeFaceAttributes,
} from "./processFaceAttributes.ts";
import { PermanentImageError } from "./imageAnalysisWorker.ts";
import { markWorkerEvictedError } from "../taskOrchestrator/computeWorkers.ts";

type SavedResult = { id: number; attributes: FaceAttributes };

/**
 * DB double whose queue drains as faces are stamped, so the task terminates the
 * same way it does against SQLite: `getFilesNeedingFaceAttributes` only returns
 * files that still hold unstamped faces.
 */
const makeDb = (
  files: Record<string, number[]>,
  overrides: Partial<Record<string, unknown>> = {},
) => {
  const pending = new Map(Object.entries(files).map(([p, ids]) => [p, new Set(ids)]));
  const saved: SavedResult[] = [];
  let queryCount = 0;

  const db = {
    storagePath: path.join(os.tmpdir(), "photrix-face-attributes-test"),
    getFilesNeedingFaceAttributes: jest.fn(async (limit: number) => {
      queryCount += 1;
      return [...pending.entries()]
        .filter(([, ids]) => ids.size > 0)
        .slice(0, limit)
        .map(([relativePath]) => relativePath);
    }),
    getFaceBoxesForAttributes: jest.fn(async (relativePath: string) =>
      [...(pending.get(relativePath) ?? [])].map((id) => ({
        id,
        box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
      })),
    ),
    saveFaceAttributes: jest.fn(async (results: SavedResult[]) => {
      for (const result of results) {
        saved.push(result);
        for (const ids of pending.values()) ids.delete(result.id);
      }
    }),
    countFacesTotal: jest.fn(async () => 10),
    countFacesNeedingAttributes: jest.fn(async () =>
      [...pending.values()].reduce((total, ids) => total + ids.size, 0),
    ),
    ...overrides,
  } as unknown as IndexDatabase;

  return { db, saved, getQueryCount: () => queryCount, pending };
};

const scoreAll =
  (attributes: FaceAttributes): AnalyzeFaceAttributes =>
  async (_imagePath, faces) =>
    new Map(faces.map(({ id }) => [id, attributes]));

describe("processFaceAttributes", () => {
  it("scores every stored face and drains the queue", async () => {
    const { db, saved } = makeDb({ "/a.jpg": [1, 2], "/b.jpg": [3] });

    const runner = processFaceAttributes(db, scoreAll({ smile: 0.8, focus: 0.9 }));
    await runner.onComplete();

    expect(saved).toEqual([
      { id: 1, attributes: { smile: 0.8, focus: 0.9 } },
      { id: 2, attributes: { smile: 0.8, focus: 0.9 } },
      { id: 3, attributes: { smile: 0.8, focus: 0.9 } },
    ]);
  });

  it("passes the stored box through untouched rather than re-detecting", async () => {
    const { db } = makeDb({ "/a.jpg": [7] });
    const analyze = jest.fn(scoreAll({ smile: 0.5 }));

    await processFaceAttributes(db, analyze as AnalyzeFaceAttributes).onComplete();

    // Re-detection would replace the face rows and discard their cluster
    // assignments; the backfill must only ever score what is already there.
    expect(analyze).toHaveBeenCalledWith(expect.stringContaining("a.jpg"), [
      { id: 7, box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } },
    ]);
    expect((db as unknown as { saveFaceDetectionResult?: unknown })
      .saveFaceDetectionResult).toBeUndefined();
  });

  it("stamps faces the worker returned no attributes for", async () => {
    const { db, saved } = makeDb({ "/a.jpg": [1, 2] });
    // Only face 1 comes back; face 2 was unjudgeable.
    const analyze: AnalyzeFaceAttributes = async () => new Map([[1, { smile: 0.9 }]]);

    await processFaceAttributes(db, analyze).onComplete();

    // Face 2 must still be stamped, or the partial index would keep serving it
    // and the backfill would never drain.
    expect(saved).toEqual([
      { id: 1, attributes: { smile: 0.9 } },
      { id: 2, attributes: {} },
    ]);
  });

  it("retires faces whose source image can no longer be decoded", async () => {
    const { db, saved } = makeDb({ "/broken.jpg": [4] });
    const analyze: AnalyzeFaceAttributes = async () => {
      throw new PermanentImageError("image file is truncated");
    };

    await processFaceAttributes(db, analyze).onComplete();

    expect(saved).toEqual([{ id: 4, attributes: {} }]);
  });

  it("leaves faces queued when the worker was evicted for a user request", async () => {
    const { db, saved, pending } = makeDb({ "/a.jpg": [5] });
    let attempts = 0;
    const analyze: AnalyzeFaceAttributes = async (_imagePath, faces) => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error("worker exited");
        markWorkerEvictedError(error);
        throw error;
      }
      return new Map(faces.map(({ id }) => [id, { smile: 0.4 }]));
    };

    await processFaceAttributes(db, analyze).onComplete();

    // The eviction is our doing, not the file's fault: it must be retried with
    // no attribute row written for the interrupted attempt.
    expect(attempts).toBe(2);
    expect(saved).toEqual([{ id: 5, attributes: { smile: 0.4 } }]);
    expect(pending.get("/a.jpg")!.size).toBe(0);
  });

  it("does not spin forever on a file that fails every time", async () => {
    const { db, saved } = makeDb({ "/bad.jpg": [6] });
    const analyze: AnalyzeFaceAttributes = async () => {
      throw new Error("worker timed out");
    };

    await processFaceAttributes(db, analyze).onComplete();

    // A transient failure at the head of an ordered queue would otherwise stall
    // every file behind it, so the face is retired as unknown.
    expect(saved).toEqual([{ id: 6, attributes: {} }]);
  });

  it("completes immediately when nothing needs scoring", async () => {
    const { db, saved, getQueryCount } = makeDb({});

    const runner = processFaceAttributes(db, scoreAll({ smile: 1 }));
    await runner.onComplete();

    expect(saved).toEqual([]);
    expect(getQueryCount()).toBe(1);
    expect(runner.getStatus).toBeDefined();
  });

  it("reports progress against the whole face table", async () => {
    const { db } = makeDb({ "/a.jpg": [1, 2] });
    const runner = processFaceAttributes(db, scoreAll({ smile: 0.2 }));
    await runner.onComplete();

    const status = await runner.getStatus!();
    expect(status).toMatchObject({
      state: "complete",
      itemsProcessed: 10,
      total: 10,
      portionComplete: 1,
    });
    // Nothing outstanding, so no "still working" description.
    expect(status.description).toBeUndefined();
  });

  it("stops when cancelled", async () => {
    const { db } = makeDb({ "/a.jpg": [1], "/b.jpg": [2], "/c.jpg": [3] });
    let seen = 0;
    const analyze: AnalyzeFaceAttributes = async (_imagePath, faces) => {
      seen += 1;
      if (seen === 1) runner.cancel!();
      return new Map(faces.map(({ id }) => [id, { smile: 0.5 }]));
    };

    const runner = processFaceAttributes(db, analyze);
    await expect(runner.onComplete()).rejects.toThrow(
      "Face attribute processing cancelled",
    );
  });
});
