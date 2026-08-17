import { spawn } from "child_process";

type GpuVendor = "nvidia" | "amd" | "intel";

type GpuAcceleration = {
  vendor: GpuVendor;
  /** Args prepended before -i for hardware-accelerated decoding */
  hwaccelArgs: readonly string[];
  /** H.264 encoder codec name */
  h264Codec: string;
  /** Human-readable label for logging */
  label: string;
  /** Detect if stderr indicates a hardware-specific failure that warrants software fallback */
  isHardwareFailure: (stderr: string) => boolean;
  /** Encoder args for constant quality mode. Quality value maps to CQ (NVENC), QP (AMF/VAAPI). */
  cqArgs: (quality: number) => readonly string[];
  /** Encoder args for VBR mode. Quality is a fallback CQ/QP level. Consumer adds -b:v, -maxrate, -bufsize. */
  vbrArgs: (quality: number) => readonly string[];
  /**
   * Filter-chain suffix (comma-joined, appended after `scale`/`fps` filters) needed
   * before this vendor's encoder can accept the frame. NVENC and AMF accept plain
   * system-memory frames directly, so this is empty for them. `h264_vaapi` cannot —
   * it requires a hardware-resident VAAPI surface, so Intel needs an explicit
   * `format=nv12,hwupload` to push the CPU-filtered frame back onto the GPU
   * device (see `hwaccelArgs`) right before encoding.
   */
  vfExtra: string;
  /**
   * Extra input args that keep decoded frames in GPU memory instead of copying
   * every one back to system RAM. Only usable when the source codec is in
   * `hardwareDecodableCodecs` — with frames pinned to the device, a codec the
   * GPU cannot decode is a hard failure rather than a silent CPU-decode
   * fallback. Empty for vendors whose GPU-resident pipeline is built inline.
   */
  gpuFrameArgs: readonly string[];
  /**
   * ffmpeg codec names this device can decode in hardware (from `vainfo`'s VLD
   * entrypoints on Intel). Anything outside this list must use the
   * system-memory pipeline.
   */
  hardwareDecodableCodecs: readonly string[];
  /**
   * The device can scale and rotate on-GPU (VAAPI's VAEntrypointVideoProc, i.e.
   * `scale_vaapi`/`transpose_vaapi`). When true, decoded frames never have to
   * touch system memory at all; when false, the consumer must map or copy them
   * out and scale on the CPU. Probed rather than assumed: Debian's DFSG-repacked
   * `intel-media-va-driver` ships without the VPP kernels and reports no
   * VideoProc entrypoint at all, while `intel-media-va-driver-non-free` on the
   * same hardware has it.
   */
  supportsVideoProc: boolean;
};

const NVIDIA: GpuAcceleration = {
  vendor: "nvidia",
  hwaccelArgs: ["-hwaccel", "cuda"],
  h264Codec: "h264_nvenc",
  label: "NVIDIA NVENC",
  isHardwareFailure: (stderr) => {
    const s = stderr.toLowerCase();
    return s.includes("nvcuda") || s.includes("cuda") || s.includes("h264_nvenc");
  },
  cqArgs: (q) => [
    "-preset",
    "p1",
    "-tune",
    "ll",
    "-rc",
    "vbr",
    "-cq",
    String(q),
    "-b:v",
    "0",
  ],
  vbrArgs: (q) => ["-preset", "p1", "-tune", "ll", "-rc", "vbr", "-cq", String(q)],
  vfExtra: "",
  // NVIDIA's GPU-resident pipeline (scale_cuda) is built inline by the HLS
  // encoder, which selects it on rotation rather than on codec.
  gpuFrameArgs: [],
  hardwareDecodableCodecs: [],
  supportsVideoProc: false,
};

const AMD: GpuAcceleration = {
  vendor: "amd",
  hwaccelArgs: ["-hwaccel", "d3d11va"],
  h264Codec: "h264_amf",
  label: "AMD AMF",
  isHardwareFailure: (stderr) => {
    const s = stderr.toLowerCase();
    return s.includes("amf") || s.includes("h264_amf") || s.includes("directx");
  },
  cqArgs: (q) => [
    "-quality",
    "balanced",
    "-rc",
    "cqp",
    "-qp_i",
    String(q),
    "-qp_p",
    String(q),
  ],
  vbrArgs: (q) => [
    "-quality",
    "balanced",
    "-rc",
    "vbr_peak",
    "-qp_i",
    String(q),
    "-qp_p",
    String(q),
  ],
  vfExtra: "",
  gpuFrameArgs: [],
  hardwareDecodableCodecs: [],
  supportsVideoProc: false,
};

const INTEL_RENDER_DEVICE = "/dev/dri/renderD128";

const INTEL: GpuAcceleration = {
  vendor: "intel",
  // The conservative, always-safe shape: `-hwaccel vaapi` WITHOUT
  // `-hwaccel_output_format vaapi`, so the iGPU decodes and ffmpeg copies every
  // decoded frame back to system memory. That keeps ffmpeg's auto-rotate (and
  // every other CPU filter) working and silently tolerates a codec the iGPU
  // cannot decode, at the cost of a full-resolution copy per *source* frame —
  // which on 4K is most of the budget (see gpuFrameArgs). Used for sources the
  // GPU-resident pipeline can't take, and as the retry tier when it fails.
  //
  // Scaling deliberately stays on the CPU in every tier: this iGPU exposes no
  // VAEntrypointVideoProc at all, so `scale_vaapi` fails outright with
  // "the requested VAProfile is not supported".
  //
  // `-vaapi_device` additionally supplies the upload device for the encoder;
  // the hwupload in `vfExtra` is what pushes the CPU-filtered frame back onto
  // that VAAPI surface right before h264_vaapi.
  hwaccelArgs: [
    "-hwaccel",
    "vaapi",
    "-hwaccel_device",
    INTEL_RENDER_DEVICE,
    "-vaapi_device",
    INTEL_RENDER_DEVICE,
  ],
  h264Codec: "h264_vaapi",
  label: "Intel Quick Sync (VAAPI)",
  isHardwareFailure: (stderr) => {
    const s = stderr.toLowerCase();
    return (
      s.includes("vaapi") || s.includes("h264_vaapi") || s.includes("/dev/dri")
    );
  },
  cqArgs: (q) => ["-rc_mode", "CQP", "-qp", String(q)],
  // Defaults to CQP — deliberately identical to cqArgs — and is replaced with a
  // real VBR mode by the probe when the driver offers one. A driver exposing
  // only the low-power H.264 entrypoint (VAEntrypointEncSliceLP) supports CQP
  // alone, and asking it for VBR makes h264_vaapi refuse to open the encoder
  // with "Driver does not support VBR RC mode (supported modes: CQP)". That
  // killed every hardware HLS encode ~1.5s after spawn and dropped playback
  // onto a libx264 fallback at 0.02-0.14x realtime. Callers still append
  // -b:v/-maxrate/-bufsize; under CQP they are inert rather than fatal, so the
  // ABR ladder's shape is unchanged either way.
  vbrArgs: (q) => ["-rc_mode", "CQP", "-qp", String(q)],
  vfExtra: ",format=nv12,hwupload",
  // Keeping decoded frames on the device is the single biggest transcode win on
  // this box. Measured on LXC 124 decoding a 4K60 H.264 source: 0.74x realtime
  // with CPU decode, 1.04x with VAAPI decode + copy-back, 5.31x with VAAPI
  // decode and frames left on the GPU. The copy — not the decode — is the cost,
  // because it runs at full source resolution on every source frame, before the
  // `fps` filter has thrown half of them away.
  //
  // The consumer pays for this by having to do its own work: no CPU filter
  // (including ffmpeg's auto-rotate) can touch a GPU-resident frame, so the
  // chain must map/download the frames itself, and rotation must be applied
  // explicitly under `-noautorotate`.
  gpuFrameArgs: ["-hwaccel_output_format", "vaapi", "-noautorotate"],
  // VLD (decode) entrypoints reported by `vainfo` on this iGPU. Notably absent:
  // AV1. With `gpuFrameArgs` in play an undecodable codec fails the encode
  // outright instead of quietly falling back to CPU decode, so anything not
  // listed here must take the system-memory path.
  hardwareDecodableCodecs: ["h264", "hevc", "vp9", "vp8", "mpeg2video"],
  // Conservative default; detectIntel() probes the live driver and overrides it.
  supportsVideoProc: false,
};

/**
 * Result of the NVIDIA probe:
 * - "available": CUDA initialized and a context allocated cleanly.
 * - "present-oom": CUDA loaded far enough to report the card, but couldn't
 *   allocate a context because VRAM is currently exhausted. The GPU exists and
 *   NVENC works — this is the reclaimable case: a user transcode frees VRAM from
 *   background ML workers (see ensureGpuHeadroom) before encoding. Treating this
 *   as "no GPU" is what made a saturated card fall back to raw direct playback.
 * - "absent": no usable NVIDIA GPU (driver/library missing, or ffmpeg lacks CUDA).
 */
type NvidiaProbeResult = "available" | "present-oom" | "absent";

const probeNvidia = (): Promise<NvidiaProbeResult> =>
  new Promise<NvidiaProbeResult>((resolve) => {
    const proc = spawn("ffmpeg", [
      "-hide_banner",
      "-init_hw_device",
      "cuda",
      "-f",
      "lavfi",
      "-i",
      "nullsrc",
      "-t",
      "0",
      "-f",
      "null",
      "-",
    ]);

    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve("available");
        return;
      }
      const s = stderr.toLowerCase();
      // Driver/library genuinely missing, or ffmpeg built without CUDA → no GPU.
      if (
        s.includes("cannot load nvcuda.dll") ||
        s.includes("could not dynamically load cuda")
      ) {
        resolve("absent");
        return;
      }
      // CUDA initialized enough to attempt (and fail) a context allocation for
      // lack of free VRAM. The hardware is present and NVENC-capable; the memory
      // pressure is transient and reclaimed at encode time.
      if (s.includes("out of memory")) {
        resolve("present-oom");
        return;
      }
      resolve("absent");
    });

    proc.on("error", () => resolve("absent"));
  });

const probeAmd = (): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    const proc = spawn("ffmpeg", [
      "-hide_banner",
      "-f",
      "lavfi",
      "-i",
      "nullsrc=s=64x64",
      "-frames:v",
      "1",
      "-c:v",
      "h264_amf",
      "-f",
      "null",
      "-",
    ]);

    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });

// Encodes one tiny frame through a VAAPI filter chain, so a driver/permissions
// problem on /dev/dri — or a missing driver capability — is caught here rather
// than surfacing mid-encode later. `vf` and `encoderArgs` vary per capability.
const probeVaapi = (vf: string, encoderArgs: readonly string[]): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    const proc = spawn("ffmpeg", [
      "-hide_banner",
      "-vaapi_device",
      INTEL_RENDER_DEVICE,
      "-f",
      "lavfi",
      "-i",
      "nullsrc=s=64x64",
      "-vf",
      vf,
      "-frames:v",
      "1",
      "-c:v",
      "h264_vaapi",
      ...encoderArgs,
      "-f",
      "null",
      "-",
    ]);

    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });

/** The runtime path: CPU frame → hwupload → h264_vaapi. */
const probeIntel = (): Promise<boolean> => probeVaapi("format=nv12,hwupload", []);

/**
 * Whether the driver can scale on the GPU. Two identically-named drivers differ
 * here: Debian's DFSG-repacked intel-media-va-driver reports no VideoProc
 * entrypoint (scale_vaapi fails with "the requested VAProfile is not
 * supported"), the non-free build on the same silicon has it, and the
 * difference is worth ~4x on a 4K transcode. Hence a probe, not a constant.
 */
const probeIntelVideoProc = (): Promise<boolean> =>
  probeVaapi("format=nv12,hwupload,scale_vaapi=32:32:format=nv12", []);

/**
 * Whether the encoder offers a real VBR rate-control mode. Low-power-only
 * H.264 entrypoints support CQP alone and fail to open under VBR.
 */
const probeIntelVbr = (): Promise<boolean> =>
  probeVaapi("format=nv12,hwupload", [
    "-rc_mode",
    "VBR",
    "-b:v",
    "1M",
    "-maxrate",
    "2M",
  ]);

/**
 * Resolves the Intel descriptor against what this specific driver build can
 * actually do, rather than what the hardware is nominally capable of.
 */
const detectIntel = async (): Promise<GpuAcceleration | null> => {
  if (!(await probeIntel())) return null;
  const [videoProc, vbr] = await Promise.all([
    probeIntelVideoProc(),
    probeIntelVbr(),
  ]);
  return {
    ...INTEL,
    supportsVideoProc: videoProc,
    // Under VBR the caller's -b:v/-maxrate/-bufsize are what define the target,
    // so the quality argument drops out; under CQP they are inert and the qp is
    // what matters. Hence the two shapes rather than one parameterized string.
    ...(vbr ? { vbrArgs: () => ["-rc_mode", "VBR"] } : {}),
  };
};

const detect = async (): Promise<GpuAcceleration | null> => {
  // "present-oom" still means an NVENC-capable card exists — treat it as NVIDIA
  // so negotiation offers HLS and the encoder reclaims VRAM rather than falling
  // back to raw direct playback on a momentarily-full card.
  if ((await probeNvidia()) !== "absent") {
    return NVIDIA;
  }
  if (await probeAmd()) {
    return AMD;
  }
  return detectIntel();
};

// Once a GPU is confirmed it never changes, so cache it permanently.
// A null result (probe failed) is not cached — the probe may have failed
// transiently (e.g. during ML model loading), so we retry after a cooldown.
const RETRY_COOLDOWN_MS = 60_000;
let gpuResult: GpuAcceleration | null | undefined = undefined;
let gpuPromise: Promise<GpuAcceleration | null> | null = null;
let lastNullMs = 0;

export const getGpuAcceleration = (): Promise<GpuAcceleration | null> => {
  if (gpuResult != null) {
    return Promise.resolve(gpuResult);
  }
  if (Date.now() - lastNullMs < RETRY_COOLDOWN_MS) {
    return Promise.resolve(null);
  }
  if (!gpuPromise) {
    gpuPromise = detect().then((result) => {
      gpuPromise = null;
      if (result) {
        gpuResult = result;
      } else {
        lastNullMs = Date.now();
      }
      return result;
    });
  }
  return gpuPromise;
};

export const resetGpuAccelerationForTests = (value: GpuAcceleration | null) => {
  gpuResult = value ?? undefined;
  gpuPromise = null;
  lastNullMs = 0;
};

export { NVIDIA, AMD, INTEL };
export type { GpuAcceleration, GpuVendor };
