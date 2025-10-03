import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as metadataModule from "./metadata.js";

describe("buildIndexedRecord video metadata", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("includes video metadata when probe succeeds", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "photrix-video-meta-"));
    const videoPath = path.join(root, "clip.mp4");
    await writeFile(videoPath, "not-a-real-video");

    const probeSpy = vi
      .spyOn(metadataModule.videoMetadataProbe, "probe")
      .mockResolvedValue({
        width: 1920,
        height: 1080,
        duration: 3.2,
        framerate: 29.97,
        videoCodec: "h264",
        audioCodec: "aac",
      });

    const record = await metadataModule.buildIndexedRecord(root, videoPath);

    expect(probeSpy).toHaveBeenCalledWith(videoPath);
    expect(record.metadata.dimensions).toEqual({ width: 1920, height: 1080 });
    expect(record.metadata.duration).toBe(3.2);
    expect(record.metadata.framerate).toBeCloseTo(29.97, 2);
    expect(record.metadata.videoCodec).toBe("h264");
    expect(record.metadata.audioCodec).toBe("aac");
  });
});
