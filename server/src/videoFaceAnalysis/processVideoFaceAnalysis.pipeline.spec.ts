import { describe, it, expect } from "@jest/globals";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  MAX_CONSECUTIVE_FAILURES,
  processVideoFaceAnalysis,
} from "./processVideoFaceAnalysis.ts";
import { detected, fakeDatabase, framesAt } from "./processVideoFaceAnalysis.fixture.ts";

/**
 * The read-ahead: the next video's frames are read while the face model works
 * on the current one's, so the GPU isn't left idle during every ffmpeg run.
 * The everyday behaviour lives in processVideoFaceAnalysis.spec.ts.
 */

const videos = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    // Zero-padded and equal-sized, so cheapest-first keeps this order.
    relativePath: `v/${String(i).padStart(2, "0")}.mp4`,
    durationSeconds: 5,
    sizeBytes: 1e6,
  }));

const tick = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * Whether `dir` is gone within a few seconds. An unused read-ahead is removed
 * in the background, so a fixed wait is flaky on a loaded box.
 */
const removedSoon = async (dir: string) => {
  for (let waited = 0; waited < 5_000 && existsSync(dir); waited += 10) await sleep(10);
  return !existsSync(dir);
};

/** Records which video each extraction was for, and where it put its frames. */
const trackedExtraction = (times: number[] = [0]) => {
  const started: string[] = [];
  const outDirs = new Map<string, string>();
  const videoOf = (framePath: string) =>
    [...outDirs].find(([, dir]) => dir === path.dirname(framePath))![0];
  let active = 0;
  let mostAtOnce = 0;
  const extract = async (video: string, duration: number | undefined, outDir: string) => {
    const name = path.basename(video);
    started.push(name);
    outDirs.set(name, outDir);
    active += 1;
    mostAtOnce = Math.max(mostAtOnce, active);
    try {
      await sleep(2);
      return await framesAt(...times)(video, duration, outDir);
    } finally {
      active -= 1;
    }
  };
  return { extract, started, outDirs, videoOf, mostAtOnce: () => mostAtOnce };
};

describe("processVideoFaceAnalysis read-ahead", () => {
  it("reads the next video while the face model works on this one, across queue re-reads", async () => {
    const queue = videos(25); // more than one read of the queue (20 at a time)
    const fake = fakeDatabase(queue);
    const tracked = trackedExtraction();
    const overlapped: string[] = [];
    const runner = processVideoFaceAnalysis(
      fake.db,
      async (framePath) => {
        const name = tracked.videoOf(framePath);
        const following =
          queue[queue.findIndex((v) => v.relativePath.endsWith(name)) + 1];
        // Hold this video in the face model until the next one's read starts,
        // or give up after a while: run serially, that never happens.
        for (let waited = 0; following && waited < 200; waited++) {
          if (tracked.started.includes(path.basename(following.relativePath))) {
            overlapped.push(name);
            break;
          }
          await sleep(1);
        }
        return { faces: [detected(0)] };
      },
      tracked.extract,
    );
    await runner.onComplete();

    expect(fake.saved.size).toBe(25);
    expect(overlapped).toHaveLength(24);
    // Each video read once: the one in the face model while the queue is
    // re-read is still queued, and must not come back as the next one.
    expect(tracked.started).toEqual(queue.map((v) => path.basename(v.relativePath)));
    expect(tracked.mostAtOnce()).toBe(1);
  }, 30_000);

  it("drops the frames it read ahead when the run is cancelled", async () => {
    const fake = fakeDatabase(videos(3));
    const tracked = trackedExtraction();
    const control: { cancel?: () => void } = {};
    const runner = processVideoFaceAnalysis(
      fake.db,
      async () => {
        while (!tracked.started.includes("01.mp4")) await tick();
        await sleep(10); // let the read-ahead finish writing
        control.cancel?.();
        return { faces: [] };
      },
      tracked.extract,
    );
    control.cancel = runner.cancel;
    await expect(runner.onComplete()).rejects.toThrow();

    expect(tracked.started).toEqual(["00.mp4", "01.mp4"]);
    expect(await removedSoon(tracked.outDirs.get("01.mp4")!)).toBe(true);
    expect(fake.saved.has("v/01.mp4")).toBe(false);
  });

  it("drops the frames it read ahead when too many failures stop the run", async () => {
    const fake = fakeDatabase(videos(MAX_CONSECUTIVE_FAILURES + 3));
    const tracked = trackedExtraction();
    const runner = processVideoFaceAnalysis(
      fake.db,
      async () => ({ facesError: "CUDA error" }),
      tracked.extract,
    );
    await runner.onComplete();

    expect(fake.errors).toHaveLength(MAX_CONSECUTIVE_FAILURES);
    // One read ahead of the last failure, never used and never stamped.
    expect(tracked.started).toHaveLength(MAX_CONSECUTIVE_FAILURES + 1);
    const unused = tracked.started.at(-1)!;
    expect(fake.errors).not.toContain(`v/${unused}`);
    expect(await removedSoon(tracked.outDirs.get(unused)!)).toBe(true);
  });
});
