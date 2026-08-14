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
};

const INTEL_RENDER_DEVICE = "/dev/dri/renderD128";

const INTEL: GpuAcceleration = {
  vendor: "intel",
  // Device init only — decode stays on the CPU (simpler and rotation-safe, see
  // generateMultibitrateHLS's NVDEC+NVENC path for the same tradeoff); the
  // hwupload in `vfExtra` is what pushes the CPU-filtered frame onto this
  // device's VAAPI surface right before the encoder.
  hwaccelArgs: ["-vaapi_device", INTEL_RENDER_DEVICE],
  h264Codec: "h264_vaapi",
  label: "Intel Quick Sync (VAAPI)",
  isHardwareFailure: (stderr) => {
    const s = stderr.toLowerCase();
    return (
      s.includes("vaapi") || s.includes("h264_vaapi") || s.includes("/dev/dri")
    );
  },
  cqArgs: (q) => ["-rc_mode", "CQP", "-qp", String(q)],
  vbrArgs: (q) => ["-rc_mode", "VBR", "-qp", String(q)],
  vfExtra: ",format=nv12,hwupload",
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

// Encodes one tiny frame through the exact hwupload→h264_vaapi path used at
// runtime, so a driver/permissions problem on /dev/dri is caught here rather
// than surfacing mid-encode later.
const probeIntel = (): Promise<boolean> =>
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
      "format=nv12,hwupload",
      "-frames:v",
      "1",
      "-c:v",
      "h264_vaapi",
      "-f",
      "null",
      "-",
    ]);

    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });

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
  if (await probeIntel()) {
    return INTEL;
  }
  return null;
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
