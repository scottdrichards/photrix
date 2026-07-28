import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, readFileSync, accessSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const makeSpawnProcess = () => {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = () => undefined;
  return proc;
};

afterEach(() => {
  jest.resetModules();
  jest.restoreAllMocks();
  delete process.env.CACHE_DIR;
  delete process.env.HLS_CACHE_DIR;
  delete process.env.HLS_ENCODE_VERBOSE;
});

describe("prepareMultibitrateHLSStructure", () => {
  it("writes a master playlist advertising every variant for ABR, and creates their dirs", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "photrix-abr-prepare-"));
    process.env.CACHE_DIR = root;
    process.env.HLS_CACHE_DIR = root;
    const source = path.join(root, "video.mp4");
    writeFileSync(source, "video");

    const {
      prepareMultibitrateHLSStructure,
      getMasterPlaylistPath,
      getMultibitrateHLSDirectory,
    } = await import("./generateMultibitrateHLS.ts");

    await prepareMultibitrateHLSStructure(source);

    const hlsDir = getMultibitrateHLSDirectory(source);
    const master = readFileSync(getMasterPlaylistPath(hlsDir), "utf-8");
    expect(master).toContain("#EXT-X-STREAM-INF");
    // All variants are advertised so the player can adapt between them mid-stream.
    expect(master).toContain("360p/playlist.m3u8");
    expect(master).toContain("720p/playlist.m3u8");
    expect(master).toContain("1080p/playlist.m3u8");
    // Lowest bitrate listed first so the player starts conservatively.
    expect(master.indexOf("360p")).toBeLessThan(master.indexOf("1080p"));
    // Every variant directory exists.
    for (const h of ["360p", "720p", "1080p"]) {
      expect(() => accessSync(path.join(hlsDir, h))).not.toThrow();
    }
  });
});

describe("generateVariantHLS", () => {
  it("uses full CUDA pipeline for landscape NVIDIA encode", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "photrix-abr-variant-"));
    process.env.CACHE_DIR = root;
    process.env.HLS_CACHE_DIR = root;
    const source = path.join(root, "video.mp4");
    writeFileSync(source, "video");

    const spawnMock = jest.fn((command: string, args: string[]) => {
      const proc = makeSpawnProcess();
      queueMicrotask(() => {
        // Rotation probe — return no rotation so full CUDA pipeline is used.
        if (command === "ffprobe") {
          proc.stdout.emit("data", JSON.stringify({ streams: [] }));
          proc.emit("close", 0);
          return;
        }
        // GPU detection probe resolves to NVIDIA.
        if (args.includes("-init_hw_device")) {
          proc.emit("close", 0);
          return;
        }
        // Encode call — last arg is the variant playlist path.
        const playlistPath = args.at(-1);
        if (playlistPath) writeFileSync(playlistPath, "#EXTM3U");
        proc.emit("close", 0);
      });
      return proc;
    });

    jest.unstable_mockModule("child_process", () => ({ spawn: spawnMock }));

    const { generateVariantHLS } = await import("./generateMultibitrateHLS.ts");

    await generateVariantHLS(source, 720);

    // 1 rotation probe (ffprobe) + 1 GPU detection + 1 encode call.
    expect(spawnMock).toHaveBeenCalledTimes(3);

    const encodeArgs = spawnMock.mock.calls[2]?.[1] as string[];
    // Full CUDA pipeline: frames stay on GPU via hwaccel_output_format cuda.
    expect(encodeArgs).toContain("-hwaccel_output_format");
    expect(encodeArgs).toContain("cuda");
    // Scales on GPU and forces 8-bit so h264_nvenc accepts 10-bit HEVC sources.
    expect(encodeArgs).toContain("scale_cuda=-2:720:format=yuv420p");
    // Frame rate forced with -r (no CPU fps filter on CUDA frames).
    expect(encodeArgs).toContain("-r");
    // Always encodes from segment 0: no input seek, segments numbered from 0.
    expect(encodeArgs).not.toContain("-ss");
    expect(encodeArgs).not.toContain("-copyts");
    expect(encodeArgs[encodeArgs.indexOf("-start_number") + 1]).toBe("0");
  });

  it("uses NVDEC+NVENC (CPU auto-rotate) for rotated/portrait videos on NVIDIA", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "photrix-abr-portrait-"));
    process.env.CACHE_DIR = root;
    process.env.HLS_CACHE_DIR = root;
    const source = path.join(root, "portrait.mp4");
    writeFileSync(source, "video");

    const spawnMock = jest.fn((command: string, args: string[]) => {
      const proc = makeSpawnProcess();
      queueMicrotask(() => {
        if (command === "ffprobe") {
          // Report 90° rotation (portrait phone video). codec_type required for detection.
          proc.stdout.emit(
            "data",
            JSON.stringify({
              streams: [{ codec_type: "video", tags: { rotate: "90" } }],
            }),
          );
          proc.emit("close", 0);
          return;
        }
        if (args.includes("-init_hw_device")) {
          proc.emit("close", 0);
          return;
        }
        const playlistPath = args.at(-1);
        if (playlistPath) writeFileSync(playlistPath, "#EXTM3U");
        proc.emit("close", 0);
      });
      return proc;
    });

    jest.unstable_mockModule("child_process", () => ({ spawn: spawnMock }));

    const { generateVariantHLS } = await import("./generateMultibitrateHLS.ts");

    await generateVariantHLS(source, 720);

    const encodeArgs = spawnMock.mock.calls[2]?.[1] as string[];
    // NVDEC: use -hwaccel cuda for GPU decode, but WITHOUT -hwaccel_output_format cuda
    // so decoded frames land on CPU where ffmpeg's auto-rotate (transpose) can run.
    expect(encodeArgs).toContain("-hwaccel");
    expect(encodeArgs).toContain("cuda");
    expect(encodeArgs).not.toContain("-hwaccel_output_format");
    // GPU encode: h264_nvenc re-uploads CPU frames to GPU.
    expect(encodeArgs).toContain("h264_nvenc");
    // CPU filter chain: fps= in vf, no -r flag needed.
    const vfArg = encodeArgs[encodeArgs.indexOf("-vf") + 1] as string;
    expect(vfArg).toContain("fps=");
    expect(encodeArgs).not.toContain("-r");
    // No seek: always from start.
    expect(encodeArgs).not.toContain("-ss");
  });

  it("falls back to software encoding when hardware encode fails", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "photrix-abr-variant-fallback-"));
    process.env.CACHE_DIR = root;
    process.env.HLS_CACHE_DIR = root;
    const source = path.join(root, "video.mp4");
    writeFileSync(source, "video");

    const spawnMock = jest.fn((command: string, args: string[]) => {
      const proc = makeSpawnProcess();
      queueMicrotask(() => {
        if (command === "ffprobe") {
          proc.stdout.emit("data", JSON.stringify({ streams: [] }));
          proc.emit("close", 0);
          return;
        }
        if (args.includes("-init_hw_device")) {
          proc.emit("close", 0);
          return;
        }
        // Hardware encode attempt fails with a CUDA error.
        if (args.includes("h264_nvenc")) {
          proc.stderr.emit("data", Buffer.from("h264_nvenc failed: Could not load CUDA"));
          proc.emit("close", 1);
          return;
        }
        // Software fallback — write the playlist.
        const playlistPath = args.at(-1);
        if (playlistPath) writeFileSync(playlistPath, "#EXTM3U");
        proc.emit("close", 0);
      });
      return proc;
    });

    jest.unstable_mockModule("child_process", () => ({ spawn: spawnMock }));

    const { generateVariantHLS } = await import("./generateMultibitrateHLS.ts");

    await generateVariantHLS(source, 720);

    // 1 rotation probe (ffprobe) + 1 GPU detection + 1 hardware attempt (fails) + 1 software retry.
    expect(spawnMock).toHaveBeenCalledTimes(4);
    const retryArgs = spawnMock.mock.calls[3]?.[1] as string[];
    expect(retryArgs).toContain("libx264");
  });

  it("rejects when ffmpeg fails without a hardware fallback signal", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "photrix-abr-variant-fail-"));
    process.env.CACHE_DIR = root;
    process.env.HLS_CACHE_DIR = root;
    const source = path.join(root, "video.mp4");
    writeFileSync(source, "video");

    const spawnMock = jest.fn((command: string, _args: string[]) => {
      const proc = makeSpawnProcess();
      queueMicrotask(() => {
        if (command === "ffprobe") {
          proc.stdout.emit("data", JSON.stringify({ streams: [] }));
          proc.emit("close", 0);
          return;
        }
        proc.stderr.emit("data", Buffer.from("unrecoverable ffmpeg failure"));
        proc.emit("close", 1);
      });
      return proc;
    });

    jest.unstable_mockModule("child_process", () => ({ spawn: spawnMock }));

    const { generateVariantHLS } = await import("./generateMultibitrateHLS.ts");

    await expect(generateVariantHLS(source, 720)).rejects.toThrow(/generation failed/i);
  });
});
