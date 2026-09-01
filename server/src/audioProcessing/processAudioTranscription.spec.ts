import { afterEach, describe, expect, it, jest } from "@jest/globals";
import path from "node:path";
import os from "node:os";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";

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

const createDb = (
  rows: Array<{ relativePath: string; durationSeconds?: number }>,
  overrides: Partial<Record<string, unknown>> = {},
) => {
  let served = false;
  return {
    storagePath: path.join(os.tmpdir(), "photrix-audio-transcription-test"),
    getFilesNeedingAudioTranscription: jest.fn(async () => {
      if (served) return [];
      served = true;
      return rows;
    }),
    saveAudioTranscription: jest.fn(async () => undefined),
    saveAudioTranscriptionError: jest.fn(async () => undefined),
    getAudioTranscriptionProgress: jest.fn(async () => [rows.length, 0]),
    ...overrides,
  } as unknown as IndexDatabase;
};

describe("processAudioTranscription", () => {
  it("passes each file's duration through so the timeout can be sized to it", async () => {
    const db = createDb([
      { relativePath: "/clips/short.mp4", durationSeconds: 12 },
      { relativePath: "/clips/long.mp4", durationSeconds: 7200 },
    ]);

    const seen: Array<[string, number | undefined]> = [];
    const transcribe = jest.fn(
      async (videoPath: string, durationSeconds?: number) => {
        seen.push([videoPath, durationSeconds]);
        return [];
      },
    );

    const { processAudioTranscription } = await import("./processAudioTranscription.ts");
    await processAudioTranscription(db, transcribe).onComplete();

    expect(seen.map(([, duration]) => duration)).toEqual([12, 7200]);
    expect(seen[0]?.[0].endsWith(path.join("clips", "short.mp4"))).toBe(true);
  });

  it("transcribes one file at a time so a queued file does not burn its own timeout", async () => {
    // There is a single Whisper worker process handling requests serially, so a
    // second in-flight request would only sit in its queue while its timeout ran.
    const db = createDb([
      { relativePath: "/a.mp4", durationSeconds: 60 },
      { relativePath: "/b.mp4", durationSeconds: 60 },
    ]);

    const gate = createDeferred();
    let active = 0;
    let maxActive = 0;
    let started = 0;
    const transcribe = jest.fn(async () => {
      started += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (started === 1) await gate.promise;
      active -= 1;
      return [];
    });

    const { processAudioTranscription } = await import("./processAudioTranscription.ts");
    const runner = processAudioTranscription(db, transcribe);

    await wait(30);
    expect(started).toBe(1);
    expect(maxActive).toBe(1);

    gate.resolve();
    await runner.onComplete();

    expect(started).toBe(2);
    expect(maxActive).toBe(1);
  });

  it("records a failure so the file is not retried immediately", async () => {
    const db = createDb([{ relativePath: "/huge.mp4", durationSeconds: 36000 }]);
    const transcribe = jest.fn(async () => {
      throw new Error("Whisper worker timed out for request 1");
    });

    const { processAudioTranscription } = await import("./processAudioTranscription.ts");
    await processAudioTranscription(db, transcribe).onComplete();

    expect(db.saveAudioTranscriptionError).toHaveBeenCalledWith("/huge.mp4");
    expect(db.saveAudioTranscription).not.toHaveBeenCalled();
  });
});
