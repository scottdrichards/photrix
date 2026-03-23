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
      completed: 0,
      remaining: 0,
    });
    expect(snapshot.failures).toBe(0);
  });

  it("completes immediately when no videos need encoding and calls onComplete", async () => {
    let completed = false;
    const database = {
      storagePath: path.join(os.tmpdir(), "photrix-hls-empty"),
      resetInProgressConversions: () => {},
      getNextConversionTasks: () => [],
      countPendingConversions: () => ({ thumbnail: 0, hls: 0 }),
    } as unknown as IndexDatabase;

    const pause = startBackgroundHLSEncoding(database, () => {
      completed = true;
    });

    pause(5);
    await wait(20);

    expect(completed).toBe(true);
    const snapshot = getHLSEncodingStatus();
    expect(snapshot.active).toBe(false);
    expect(snapshot.videos.completed).toBe(0);
    expect(snapshot.failures).toBe(0);
  });
});
