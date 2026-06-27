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

    const { prepareMultibitrateHLSStructure, getMasterPlaylistPath, getMultibitrateHLSDirectory } =
      await import("./generateMultibitrateHLS.ts");

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
  it("encodes exactly one variant, GPU-resident on NVIDIA", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "photrix-abr-variant-"));
    process.env.CACHE_DIR = root;
    process.env.HLS_CACHE_DIR = root;
    const source = path.join(root, "video.mp4");
    writeFileSync(source, "video");

    const spawnMock = jest.fn((_command: string, args: string[]) => {
      const proc = makeSpawnProcess();
      queueMicrotask(() => {
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

    // 1 GPU detection call + 1 encode call (a single variant).
    expect(spawnMock).toHaveBeenCalledTimes(2);

    const encodeArgs = spawnMock.mock.calls[1]?.[1] as string[];
    expect(encodeArgs).toContain("-hwaccel_output_format");
    // Scales to the chosen height and converts to 8-bit on the GPU so 10-bit HEVC
    // (HDR) sources don't fail h264_nvenc and drop to slow software encoding.
    expect(encodeArgs).toContain("scale_cuda=-2:720:format=yuv420p");
    // No other variant is encoded.
    expect(encodeArgs).not.toContain("scale_cuda=-2:360:format=yuv420p");
    expect(encodeArgs).not.toContain("scale_cuda=-2:1080:format=yuv420p");
    // Frame rate forced with -r (no CPU fps filter on CUDA frames).
    expect(encodeArgs).toContain("-r");
    // From-the-start encode: no input seek, segments numbered from 0.
    expect(encodeArgs).not.toContain("-ss");
    expect(encodeArgs).not.toContain("-copyts");
    expect(encodeArgs.slice(encodeArgs.indexOf("-start_number"))).toContain("0");
  });

  it("offset-encodes from a given start segment for mid-stream switches/seeks", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "photrix-abr-variant-offset-"));
    process.env.CACHE_DIR = root;
    process.env.HLS_CACHE_DIR = root;
    const source = path.join(root, "video.mp4");
    writeFileSync(source, "video");

    const spawnMock = jest.fn((_command: string, args: string[]) => {
      const proc = makeSpawnProcess();
      queueMicrotask(() => {
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

    // HLS_SEGMENT_SECONDS is 1, so segment 300 starts at 300s.
    await generateVariantHLS(source, 720, { startSegment: 300 });

    const encodeArgs = spawnMock.mock.calls[1]?.[1] as string[];
    // Seeks the input to the segment boundary and preserves source timestamps so the
    // same segment index has identical PTS across variants (seamless ABR switching).
    expect(encodeArgs).toContain("-ss");
    expect(encodeArgs[encodeArgs.indexOf("-ss") + 1]).toBe("300");
    expect(encodeArgs).toContain("-copyts");
    // Output segments numbered from 300 so they line up with the synthetic playlist.
    expect(encodeArgs[encodeArgs.indexOf("-start_number") + 1]).toBe("300");
  });

  it("falls back to software encoding when hardware encode fails", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "photrix-abr-variant-fallback-"));
    process.env.CACHE_DIR = root;
    process.env.HLS_CACHE_DIR = root;
    const source = path.join(root, "video.mp4");
    writeFileSync(source, "video");

    const spawnMock = jest.fn((_command: string, args: string[]) => {
      const proc = makeSpawnProcess();
      queueMicrotask(() => {
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

    // 1 GPU detection + 1 hardware attempt (fails) + 1 software retry.
    expect(spawnMock).toHaveBeenCalledTimes(3);
    const retryArgs = spawnMock.mock.calls[2]?.[1] as string[];
    expect(retryArgs).toContain("libx264");
  });

  it("rejects when ffmpeg fails without a hardware fallback signal", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "photrix-abr-variant-fail-"));
    process.env.CACHE_DIR = root;
    process.env.HLS_CACHE_DIR = root;
    const source = path.join(root, "video.mp4");
    writeFileSync(source, "video");

    const spawnMock = jest.fn((_command: string, _args: string[]) => {
      const proc = makeSpawnProcess();
      queueMicrotask(() => {
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
