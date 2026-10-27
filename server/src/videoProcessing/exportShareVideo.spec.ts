import { describe, expect, it } from "@jest/globals";
import {
  buildShareVideoArgs,
  parseShareVideoShortSide,
  shareOutputHeight,
} from "./exportShareVideo.ts";
import { INTEL } from "./gpuAcceleration.ts";
import type { VideoSourceProfile } from "./getVideoMetadata.ts";

const source = (overrides: Partial<VideoSourceProfile> = {}): VideoSourceProfile => ({
  rotation: 0,
  codec: "hevc",
  pixelFormat: "yuv420p10le",
  colorTransfer: "",
  frameRate: "60/1",
  width: 3840,
  height: 2160,
  ...overrides,
});

const intel = { ...INTEL, supportsVideoProc: true };
const argAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe("shareOutputHeight", () => {
  it("gives a landscape clip the requested short side as its height", () => {
    expect(shareOutputHeight(1080, source())).toBe(1080);
    expect(shareOutputHeight(720, source())).toBe(720);
  });

  it("gives a portrait clip the long side, so 1080 means 1080x1920 not 608x1080", () => {
    expect(
      shareOutputHeight(1080, source({ width: 1920, height: 1080, rotation: 90 })),
    ).toBe(1920);
    expect(
      shareOutputHeight(720, source({ width: 1920, height: 1080, rotation: 270 })),
    ).toBe(1280);
  });

  it("never upscales a source smaller than the requested size", () => {
    expect(shareOutputHeight(1080, source({ width: 640, height: 480 }))).toBe(480);
  });

  it("keeps the output even, which H.264 4:2:0 requires", () => {
    expect(
      shareOutputHeight(720, source({ width: 1080, height: 1350, rotation: 0 })) % 2,
    ).toBe(0);
  });

  it("falls back to the requested size when ffprobe gave no dimensions", () => {
    expect(shareOutputHeight(720, source({ width: undefined, height: undefined }))).toBe(
      720,
    );
  });
});

describe("parseShareVideoShortSide", () => {
  it("accepts 720 and defaults everything else to 1080", () => {
    expect(parseShareVideoShortSide("720")).toBe(720);
    expect(parseShareVideoShortSide("1080")).toBe(1080);
    expect(parseShareVideoShortSide(null)).toBe(1080);
    expect(parseShareVideoShortSide("4320")).toBe(1080);
  });
});

describe("buildShareVideoArgs", () => {
  it("resets the display matrix when the pipeline rotates the frames itself", () => {
    // Without the reset the MP4 inherits the source's rotation and a player
    // turns the already-upright picture again.
    const { args } = buildShareVideoArgs(
      "in.mov",
      "out.mp4",
      1080,
      1920,
      intel,
      source({ rotation: 90 }),
      "gpu-frames",
    );
    expect(args).toContain("-noautorotate");
    expect(args.indexOf("-display_rotation")).toBeLessThan(args.indexOf("-i"));
    expect(argAfter(args, "-display_rotation")).toBe("0");
  });

  it("leaves the matrix alone on an auto-rotating pipeline, which needs it to rotate", () => {
    const { args } = buildShareVideoArgs(
      "in.mov",
      "out.mp4",
      1080,
      1920,
      null,
      source({ rotation: 90 }),
      "software",
    );
    expect(args).not.toContain("-noautorotate");
    expect(args).not.toContain("-display_rotation");
  });

  it("always sets a target bitrate, which a VBR encoder refuses to open without", () => {
    for (const [side, rate] of [
      [1080, "8M"],
      [720, "4M"],
    ] as const) {
      for (const [gpu, tier] of [
        [intel, "gpu-frames"],
        [intel, "system-frames"],
        [null, "software"],
      ] as const) {
        const { args } = buildShareVideoArgs(
          "in.mov",
          "out.mp4",
          side,
          side,
          gpu,
          source(),
          tier,
        );
        expect(argAfter(args, "-b:v")).toBe(rate);
      }
    }
  });

  it("writes a faststart MP4 with one video and an optional audio stream", () => {
    const { args } = buildShareVideoArgs(
      "in.mov",
      "out.mp4",
      720,
      720,
      null,
      source(),
      "software",
    );
    expect(argAfter(args, "-movflags")).toBe("+faststart");
    expect(argAfter(args, "-f")).toBe("mp4");
    expect(args.join(" ")).toContain("-map 0:v:0 -map 0:a:0?");
    expect(args[args.length - 1]).toBe("out.mp4");
  });
});
