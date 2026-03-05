import { describe, expect, it } from "@jest/globals";
import path from "node:path";
import os from "node:os";
import type { IndexDatabase } from "./indexDatabase.ts";
import {
  getHLSEncodingStatus,
  startBackgroundHLSEncoding,
} from "./processHLSEncoding.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("processHLSEncoding", () => {
  it("reports idle snapshot by default", () => {
    const snapshot = getHLSEncodingStatus();

    expect(snapshot.active).toBe(false);
    expect(snapshot.videos).toEqual({
      total: 0,
      completed: 0,
      remaining: 0,
      queued: 0,
    });
    expect(snapshot.videoSeconds).toEqual({
      total: 0,
      completed: 0,
      remaining: 0,
      queued: 0,
    });
    expect(snapshot.failures).toBe(0);
  });

  it("completes immediately when no videos need encoding and calls onComplete", async () => {
    let completed = false;
    const database = {
      storagePath: path.join(os.tmpdir(), "photrix-hls-empty"),
      countVideosReadyForHLS: () => 0,
      getVideosReadyForHLS: () => [],
    } as unknown as IndexDatabase;

    const pause = startBackgroundHLSEncoding(database, () => {
      completed = true;
    });

    pause(5);
    await wait(20);

    expect(completed).toBe(true);
    const snapshot = getHLSEncodingStatus();
    expect(snapshot.active).toBe(false);
    expect(snapshot.videos.total).toBe(0);
    expect(snapshot.videoSeconds.total).toBe(0);
    expect(snapshot.failures).toBe(0);
  });
});
