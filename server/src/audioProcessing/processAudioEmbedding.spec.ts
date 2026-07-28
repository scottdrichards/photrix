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

describe("processAudioEmbedding", () => {
  it("serializes background CLAP requests so timeout only covers active work", async () => {
    const access = jest.fn(async () => undefined);
    jest.unstable_mockModule("node:fs/promises", () => ({ access }));

    const rows = [{ relativePath: "a.mp4" }, { relativePath: "b.mp4" }];
    let served = false;
    const saves: string[] = [];
    const db = {
      storagePath: path.join(os.tmpdir(), "photrix-audio-embedding-test"),
      getFilesNeedingAudioEmbedding: jest.fn(async () => {
        if (served) return [];
        served = true;
        return rows;
      }),
      saveAudioEmbedding: jest.fn(async (relativePath: string) => {
        saves.push(relativePath);
      }),
      saveAudioEmbeddingError: jest.fn(async () => undefined),
    } as unknown as IndexDatabase;

    const gate = createDeferred();
    let active = 0;
    let maxActive = 0;
    let started = 0;
    const embedAudio = jest.fn(async () => {
      started += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (started === 1) await gate.promise;
      active -= 1;
      return new Float32Array([1, 2, 3]);
    });

    const { processAudioEmbedding } = await import("./processAudioEmbedding.ts");

    const runner = processAudioEmbedding(db, embedAudio);
    await wait(30);
    expect(started).toBe(1);
    expect(maxActive).toBe(1);

    gate.resolve();
    await runner.onComplete();

    expect(embedAudio).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
    expect(saves).toEqual(["a.mp4", "b.mp4"]);
  });
});
