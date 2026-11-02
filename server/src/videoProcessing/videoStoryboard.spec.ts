import { describe, expect, it } from "@jest/globals";
import { mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import sharp from "sharp";
import {
  planStoryboard,
  storyboardFrameAt,
  storyboardFrameTime,
} from "../../../shared/video-storyboard/src/index.ts";
import { fillFrameGaps, generateVideoStoryboard } from "./videoStoryboard.ts";

describe("planStoryboard", () => {
  it("has no plan without a length", () => {
    expect(planStoryboard(undefined)).toBeNull();
    expect(planStoryboard(0)).toBeNull();
    expect(planStoryboard(Number.NaN)).toBeNull();
  });

  it("takes a frame every 2 s for a short clip", () => {
    expect(planStoryboard(35)).toEqual({ frames: 18, columns: 10, rows: 2, intervalSeconds: 2 });
    expect(planStoryboard(3)).toEqual({ frames: 2, columns: 2, rows: 1, intervalSeconds: 2 });
    expect(planStoryboard(1)).toEqual({ frames: 1, columns: 1, rows: 1, intervalSeconds: 2 });
  });

  it("caps a long video at 100 frames, spread evenly", () => {
    expect(planStoryboard(3600)).toEqual({
      frames: 100,
      columns: 10,
      rows: 10,
      intervalSeconds: 36,
    });
  });

  it("takes each frame mid-slot and maps a moment back to its frame", () => {
    const plan = planStoryboard(35)!;
    expect(storyboardFrameTime(plan, 0, 35)).toBe(1);
    expect(storyboardFrameTime(plan, 17, 35)).toBeCloseTo(34.9);
    expect(storyboardFrameAt(plan, 0)).toBe(0);
    expect(storyboardFrameAt(plan, 3.9)).toBe(1);
    expect(storyboardFrameAt(plan, 35)).toBe(17);
    expect(storyboardFrameAt(plan, -1)).toBe(0);
  });
});

describe("fillFrameGaps", () => {
  it("fills each gap from the frame before it, or after it at the start", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "storyboard-gaps-"));
    try {
      await writeFile(path.join(dir, "f001.jpg"), "one");
      await writeFile(path.join(dir, "f003.jpg"), "three");
      expect(await fillFrameGaps(dir, 5)).toBe(2);
      expect((await readdir(dir)).sort()).toEqual([
        "f000.jpg",
        "f001.jpg",
        "f002.jpg",
        "f003.jpg",
        "f004.jpg",
      ]);
      const read = (name: string) => readFile(path.join(dir, name), "utf8");
      expect(await read("f000.jpg")).toBe("one");
      expect(await read("f002.jpg")).toBe("one");
      expect(await read("f004.jpg")).toBe("three");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports none decoded when there are no frames", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "storyboard-gaps-"));
    try {
      expect(await fillFrameGaps(dir, 3)).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("generateVideoStoryboard", () => {
  const video = path.resolve("exampleFolder/subFolder/big_buck_bunny_20s_h265.mp4");

  it("builds a sprite laid out as the shared plan says", async () => {
    const sprite = await generateVideoStoryboard(video, 20);
    expect(sprite).not.toBeNull();
    const { width, height } = await sharp(sprite!).metadata();
    // 20 s: a frame every 2 s, 10 frames in one row, each 240 px on its long edge.
    expect(width).toBe(10 * 240);
    expect(height).toBeGreaterThan(100);
    expect(height).toBeLessThan(240);
    // Cached: the second call returns the same file without rebuilding.
    expect(await generateVideoStoryboard(video, 20)).toBe(sprite);
  }, 120_000);

  it("has nothing for a video of unknown length", async () => {
    expect(await generateVideoStoryboard(video, 0)).toBeNull();
  });
});
