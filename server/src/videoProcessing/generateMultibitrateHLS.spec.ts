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

/** ffprobe -show_streams payload for a video stream with the given properties. */
const probeJson = (stream: Record<string, unknown>) =>
  JSON.stringify({ streams: [{ codec_type: "video", ...stream }] });

/**
 * Spawn mock for the Intel/VAAPI box: the GPU probes report no NVIDIA and no
 * AMD, but a working VAAPI encoder. `capabilities` decides how the driver
 * answers the on-GPU-scaling (VPP) and VBR probes.
 */
const makeIntelSpawnMock = (
  probePayload: string,
  onEncode: (args: string[], proc: ReturnType<typeof makeSpawnProcess>) => void,
  capabilities: { videoProc?: boolean; vbr?: boolean } = {},
) => {
  const { videoProc = true, vbr = true } = capabilities;
  return jest.fn((command: string, args: string[]) => {
    const proc = makeSpawnProcess();
    queueMicrotask(() => {
      if (command === "ffprobe") {
        proc.stdout.emit("data", probePayload);
        proc.emit("close", 0);
        return;
      }
      // NVIDIA probe (-init_hw_device cuda) and AMD probe (h264_amf) both fail.
      if (args.includes("-init_hw_device") || args.includes("h264_amf")) {
        proc.emit("close", 1);
        return;
      }
      // Intel probes: tiny nullsrc frames exercising each capability.
      if (args.includes("nullsrc=s=64x64")) {
        const wantsVpp = args.some((a) => a.includes("scale_vaapi"));
        const wantsVbr = args.includes("VBR");
        const ok = wantsVpp ? videoProc : wantsVbr ? vbr : true;
        proc.emit("close", ok ? 0 : 1);
        return;
      }
      onEncode(args, proc);
    });
    return proc;
  });
};

/**
 * Spawn mock for a machine with a fully working NVIDIA card: CUDA initialises
 * and h264_nvenc opens, so detection settles on NVIDIA.
 */
const makeNvidiaSpawnMock = (probePayload: string) =>
  jest.fn((command: string, args: string[]) => {
    const proc = makeSpawnProcess();
    queueMicrotask(() => {
      if (command === "ffprobe") {
        proc.stdout.emit("data", probePayload);
        proc.emit("close", 0);
        return;
      }
      // CUDA probe and the NVENC encoder probe both succeed. The NVENC probe
      // has no -hls_time, so it is not mistaken for an encode below.
      if (args.includes("-init_hw_device") || !args.includes("-hls_time")) {
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

/** Args of the last real HLS encode (not a capability probe) a mock recorded. */
const lastEncodeArgs = (spawnMock: { mock: { calls: unknown[][] } }): string[] =>
  spawnMock.mock.calls
    .map((call) => call[1] as string[])
    .filter((args) => Array.isArray(args) && args.includes("-hls_time"))
    .at(-1) as string[];

/** The -vf argument of the last ffmpeg call a mock recorded. */
const lastFilterChain = (spawnMock: { mock: { calls: unknown[][] } }): string => {
  const args = spawnMock.mock.calls.at(-1)?.[1] as string[];
  return args[args.indexOf("-vf") + 1] as string;
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

    const spawnMock = makeNvidiaSpawnMock(JSON.stringify({ streams: [] }));

    jest.unstable_mockModule("child_process", () => ({ spawn: spawnMock }));

    const { generateVariantHLS } = await import("./generateMultibitrateHLS.ts");

    await generateVariantHLS(source, 720);

    const encodeArgs = lastEncodeArgs(spawnMock);
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

    // Report 90° rotation (portrait phone video). codec_type required for detection.
    const spawnMock = makeNvidiaSpawnMock(
      JSON.stringify({ streams: [{ codec_type: "video", tags: { rotate: "90" } }] }),
    );

    jest.unstable_mockModule("child_process", () => ({ spawn: spawnMock }));

    const { generateVariantHLS } = await import("./generateMultibitrateHLS.ts");

    await generateVariantHLS(source, 720);

    const encodeArgs = lastEncodeArgs(spawnMock);
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
        // Detection probes (CUDA, then the tiny NVENC encode) both succeed.
        if (args.includes("-init_hw_device") || !args.includes("-hls_time")) {
          proc.emit("close", 0);
          return;
        }
        // The real hardware encode then fails with a CUDA error.
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

    const retryArgs = lastEncodeArgs(spawnMock);
    expect(retryArgs).toContain("libx264");
  });

  it("scales and rotates entirely on the Intel iGPU when the driver has VPP", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "photrix-abr-intel-vpp-"));
    process.env.CACHE_DIR = root;
    process.env.HLS_CACHE_DIR = root;
    const source = path.join(root, "portrait.mov");
    writeFileSync(source, "video");

    const spawnMock = makeIntelSpawnMock(
      // Phone portrait 10-bit HEVC: display matrix -90, normalized to 270.
      probeJson({
        codec_name: "hevc",
        pix_fmt: "yuv420p10le",
        side_data_list: [{ rotation: -90 }],
      }),
      (args, proc) => {
        const playlistPath = args.at(-1);
        if (playlistPath) writeFileSync(playlistPath, "#EXTM3U");
        proc.emit("close", 0);
      },
    );

    jest.unstable_mockModule("child_process", () => ({ spawn: spawnMock }));
    const { generateVariantHLS } = await import("./generateMultibitrateHLS.ts");

    await generateVariantHLS(source, 720);

    const encodeArgs = spawnMock.mock.calls.at(-1)?.[1] as string[];
    expect(encodeArgs).toContain("-hwaccel_output_format");
    expect(encodeArgs).toContain("vaapi");
    // ffmpeg's auto-rotate silently no-ops on VAAPI surfaces, so rotation is
    // explicit and auto-rotate is off — otherwise portrait video plays sideways.
    expect(encodeArgs).toContain("-noautorotate");
    const vf = lastFilterChain(spawnMock);
    // Nothing crosses to system memory: no map, no copy, no CPU scale.
    expect(vf).not.toContain("hwmap");
    expect(vf).not.toContain("hwdownload");
    expect(vf).not.toContain("hwupload");
    // Scale expressed pre-rotation, so the post-transpose height is the variant.
    expect(vf).toContain("scale_vaapi=720:-2:format=nv12");
    expect(vf).toContain("transpose_vaapi=clock");
    // fps still drops frames first, so the GPU scales only what it will encode.
    expect(vf.indexOf("fps=")).toBeLessThan(vf.indexOf("scale_vaapi"));
  });

  it("maps 8-bit surfaces without copying when the driver lacks VPP", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "photrix-abr-intel-8bit-"));
    process.env.CACHE_DIR = root;
    process.env.HLS_CACHE_DIR = root;
    const source = path.join(root, "video.mp4");
    writeFileSync(source, "video");

    const spawnMock = makeIntelSpawnMock(
      probeJson({ codec_name: "h264", pix_fmt: "yuv420p" }),
      (args, proc) => {
        const playlistPath = args.at(-1);
        if (playlistPath) writeFileSync(playlistPath, "#EXTM3U");
        proc.emit("close", 0);
      },
      { videoProc: false },
    );

    jest.unstable_mockModule("child_process", () => ({ spawn: spawnMock }));
    const { generateVariantHLS } = await import("./generateMultibitrateHLS.ts");

    await generateVariantHLS(source, 720);

    const vf = lastFilterChain(spawnMock);
    // fps drops frames while they are still on the GPU, before any transfer.
    expect(vf.indexOf("fps=")).toBeLessThan(vf.indexOf("hwmap"));
    // 8-bit: mapped read-only rather than copied, and never touched as p010.
    expect(vf).toContain("hwmap=mode=read+direct,format=nv12");
    expect(vf).not.toContain("p010");
    // Landscape: scaled to the variant height, no rotation filters.
    expect(vf).toContain("scale=-2:720");
    expect(vf).not.toContain("transpose");
    expect(vf.endsWith("hwupload")).toBe(true);
  });

  it("copies 10-bit surfaces as p010 and rotates after scaling when VPP is absent", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "photrix-abr-intel-10bit-"));
    process.env.CACHE_DIR = root;
    process.env.HLS_CACHE_DIR = root;
    const source = path.join(root, "portrait.mov");
    writeFileSync(source, "video");

    const spawnMock = makeIntelSpawnMock(
      probeJson({
        codec_name: "hevc",
        pix_fmt: "yuv420p10le",
        side_data_list: [{ rotation: -90 }],
      }),
      (args, proc) => {
        const playlistPath = args.at(-1);
        if (playlistPath) writeFileSync(playlistPath, "#EXTM3U");
        proc.emit("close", 0);
      },
      { videoProc: false },
    );

    jest.unstable_mockModule("child_process", () => ({ spawn: spawnMock }));
    const { generateVariantHLS } = await import("./generateMultibitrateHLS.ts");

    await generateVariantHLS(source, 720);

    const vf = lastFilterChain(spawnMock);
    // A P010 surface downloaded as NV12 decodes to silent garbage, so the
    // transfer must name p010le and convert to 8-bit only after the scale.
    expect(vf).toContain("hwdownload,format=p010le");
    expect(vf).not.toContain("hwmap");
    expect(vf.indexOf("p010le")).toBeLessThan(vf.indexOf("format=nv12"));
    // Rotation applied after scaling, on the small frame — and the scale is
    // therefore expressed as the pre-transpose width.
    expect(vf).toContain("scale=720:-2");
    expect(vf.indexOf("scale=")).toBeLessThan(vf.indexOf("transpose"));
    // -90 display matrix means the frame needs a clockwise quarter turn.
    expect(vf).toContain("transpose=clock");
  });

  it("uses the system-memory pipeline for a codec the iGPU cannot decode", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "photrix-abr-intel-av1-"));
    process.env.CACHE_DIR = root;
    process.env.HLS_CACHE_DIR = root;
    const source = path.join(root, "av1.mp4");
    writeFileSync(source, "video");

    const spawnMock = makeIntelSpawnMock(
      probeJson({ codec_name: "av1", pix_fmt: "yuv420p" }),
      (args, proc) => {
        const playlistPath = args.at(-1);
        if (playlistPath) writeFileSync(playlistPath, "#EXTM3U");
        proc.emit("close", 0);
      },
    );

    jest.unstable_mockModule("child_process", () => ({ spawn: spawnMock }));
    const { generateVariantHLS } = await import("./generateMultibitrateHLS.ts");

    await generateVariantHLS(source, 720);

    const encodeArgs = spawnMock.mock.calls.at(-1)?.[1] as string[];
    // Pinning frames to the device turns an undecodable codec into a hard
    // failure, so AV1 keeps the tolerant copy-back shape (and hardware encode).
    expect(encodeArgs).not.toContain("-hwaccel_output_format");
    expect(encodeArgs).toContain("h264_vaapi");
    const vf = encodeArgs[encodeArgs.indexOf("-vf") + 1] as string;
    expect(vf).not.toContain("hwmap");
    expect(vf).not.toContain("hwdownload");
  });

  it("retries a failed GPU-frame encode on the system-memory pipeline, not libx264", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "photrix-abr-intel-retry-"));
    process.env.CACHE_DIR = root;
    process.env.HLS_CACHE_DIR = root;
    const source = path.join(root, "video.mp4");
    writeFileSync(source, "video");

    const spawnMock = makeIntelSpawnMock(
      probeJson({ codec_name: "h264", pix_fmt: "yuv420p" }),
      (args, proc) => {
        if (args.includes("-hwaccel_output_format")) {
          proc.stderr.emit("data", Buffer.from("hwmap: unsupported vaapi surface"));
          proc.emit("close", 1);
          return;
        }
        const playlistPath = args.at(-1);
        if (playlistPath) writeFileSync(playlistPath, "#EXTM3U");
        proc.emit("close", 0);
      },
    );

    jest.unstable_mockModule("child_process", () => ({ spawn: spawnMock }));
    const { generateVariantHLS } = await import("./generateMultibitrateHLS.ts");

    await generateVariantHLS(source, 720);

    const retryArgs = spawnMock.mock.calls.at(-1)?.[1] as string[];
    // Still on the iGPU: libx264 at ~0.1x realtime would starve the player.
    expect(retryArgs).toContain("h264_vaapi");
    expect(retryArgs).not.toContain("libx264");
    expect(retryArgs).not.toContain("-hwaccel_output_format");
  });

  it("treats a killed encode as cancellation, not as a hardware failure", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "photrix-abr-intel-killed-"));
    process.env.CACHE_DIR = root;
    process.env.HLS_CACHE_DIR = root;
    const source = path.join(root, "video.mp4");
    writeFileSync(source, "video");

    const spawnMock = makeIntelSpawnMock(
      probeJson({ codec_name: "h264", pix_fmt: "yuv420p" }),
      (_args, proc) => {
        // What the idle reaper does when the player switches variants: SIGKILL,
        // which surfaces as a null exit code plus a signal.
        proc.stderr.emit("data", Buffer.from("[h264_vaapi] encoding frame..."));
        proc.emit("close", null, "SIGKILL");
      },
    );

    jest.unstable_mockModule("child_process", () => ({ spawn: spawnMock }));
    const { generateVariantHLS } = await import("./generateMultibitrateHLS.ts");

    await expect(generateVariantHLS(source, 720)).resolves.toBeUndefined();

    // Probes + exactly one encode: no software respawn behind the user's back.
    const encodeCalls = spawnMock.mock.calls.filter(([command, args]) =>
      command === "ffmpeg" && (args as string[]).includes("-hls_time"),
    );
    expect(encodeCalls).toHaveLength(1);
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
