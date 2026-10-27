import { describe, it, expect, beforeAll, afterAll, afterEach } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ffmpeg, hasFfmpeg, makeClip } from "./brokenVideos.fixture.ts";
import { extractAnalysisFrames } from "./extractAnalysisFrames.ts";
import { INTEL, resetGpuAccelerationForTests } from "./gpuAcceleration.ts";

/**
 * Frame extraction decodes on the GPU when there is one. These check that it
 * survives the GPU going away, and, where a VAAPI device is present, that GPU
 * frames are the CPU's frames: same times, same pixels, portrait upright.
 */
const describeWithFfmpeg = hasFfmpeg ? describe : describe.skip;
const RENDER_DEVICE = "/dev/dri/renderD128";
const vaapiWorks =
  hasFfmpeg &&
  existsSync(RENDER_DEVICE) &&
  spawnSync("ffmpeg", [
    "-hide_banner",
    "-v",
    "error",
    "-hwaccel",
    "vaapi",
    "-hwaccel_device",
    RENDER_DEVICE,
    "-f",
    "lavfi",
    "-i",
    "testsrc=s=64x64:d=0.1",
    "-f",
    "null",
    "-",
  ]).status === 0;
const describeWithVaapi = vaapiWorks ? describe : describe.skip;

/** PSNR of two images in dB; identical images report infinity. */
const psnr = (a: string, b: string): number => {
  const out = spawnSync("ffmpeg", [
    "-hide_banner",
    "-i",
    a,
    "-i",
    b,
    "-lavfi",
    "psnr",
    "-f",
    "null",
    "-",
  ]).stderr.toString();
  const match = /average:(inf|[\d.]+)/.exec(out);
  if (!match) throw new Error(`no PSNR in: ${out.slice(-300)}`);
  return match[1] === "inf" ? Infinity : Number(match[1]);
};

describeWithFfmpeg("extractAnalysisFrames on a GPU", () => {
  let root: string;
  let clip: string;
  let portrait: string;
  let n = 0;
  const outDir = () => mkdtempSync(path.join(root, `out${n++}-`));

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "photrix-frames-gpu-"));
    clip = makeClip(root, "clip.mp4", { seconds: 8 });
    // A phone held upright: landscape pixels plus a 90° display rotation.
    portrait = path.join(root, "portrait.mp4");
    ffmpeg(["-display_rotation", "90", "-i", clip, "-c", "copy", portrait]);
  });

  afterEach(() => resetGpuAccelerationForTests(null));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  // 2026-08: the container lost its GPU passthrough and the device node went
  // away. A GPU that has gone must cost a retry, not the video.
  it("falls back to the CPU when the GPU device is gone, in both sampling modes", async () => {
    const missing = "/dev/dri/not-a-device";
    resetGpuAccelerationForTests({
      ...INTEL,
      hwaccelArgs: [
        "-hwaccel",
        "vaapi",
        "-hwaccel_device",
        missing,
        "-vaapi_device",
        missing,
      ],
    });
    const keyframes = await extractAnalysisFrames(clip, 8, outDir());
    expect(keyframes.map((f) => f.timeMs)).toEqual([
      0, 1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000,
    ]);
    // Claimed long, so it is sampled by seeking; only seeks inside 8 s land.
    const seeks = await extractAnalysisFrames(clip, 200, outDir());
    expect(seeks.length).toBeGreaterThan(0);
  }, 120_000);

  describeWithVaapi("with a working VAAPI device", () => {
    const vaapi = {
      ...INTEL,
      hwaccelArgs: ["-hwaccel", "vaapi", "-hwaccel_device", RENDER_DEVICE],
    };

    for (const [label, file] of [
      ["landscape", () => clip],
      ["portrait", () => portrait],
    ] as const) {
      it(`gives the CPU's frames for ${label} video`, async () => {
        resetGpuAccelerationForTests({ ...INTEL, hwaccelArgs: [] });
        const cpu = await extractAnalysisFrames(file(), 8, outDir());
        resetGpuAccelerationForTests(vaapi);
        const gpu = await extractAnalysisFrames(file(), 8, outDir());

        expect(gpu.map((f) => f.timeMs)).toEqual(cpu.map((f) => f.timeMs));
        // Upright and pixel for pixel: a sideways or flipped frame scores far
        // below 30 dB against the CPU's.
        for (const [i, frame] of gpu.entries()) {
          expect(psnr(frame.path, cpu[i].path)).toBeGreaterThan(40);
        }
      }, 120_000);
    }
  });
});
