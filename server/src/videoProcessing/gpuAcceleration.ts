import { spawn } from "child_process";

type GpuVendor = "nvidia" | "amd";

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
  /** Encoder args for constant quality mode. Quality value maps to CQ (NVENC) or QP (AMF). */
  cqArgs: (quality: number) => readonly string[];
  /** Encoder args for VBR mode. Quality is a fallback CQ/QP level. Consumer adds -b:v, -maxrate, -bufsize. */
  vbrArgs: (quality: number) => readonly string[];
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
  cqArgs: (q) => ["-preset", "p1", "-tune", "ll", "-rc", "vbr", "-cq", String(q), "-b:v", "0"],
  vbrArgs: (q) => ["-preset", "p1", "-tune", "ll", "-rc", "vbr", "-cq", String(q)],
};

const AMD: GpuAcceleration = {
  vendor: "amd",
  hwaccelArgs: [],
  h264Codec: "h264_amf",
  label: "AMD AMF",
  isHardwareFailure: (stderr) => {
    const s = stderr.toLowerCase();
    return s.includes("amf") || s.includes("h264_amf") || s.includes("directx");
  },
  cqArgs: (q) => ["-quality", "balanced", "-rc", "cqp", "-qp_i", String(q), "-qp_p", String(q)],
  vbrArgs: (q) => ["-quality", "balanced", "-rc", "vbr_peak", "-qp_i", String(q), "-qp_p", String(q)],
};

const probeNvidia = (): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
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
      resolve(
        code === 0 &&
          !stderr.includes("Cannot load nvcuda.dll") &&
          !stderr.includes("Could not dynamically load CUDA"),
      );
    });

    proc.on("error", () => resolve(false));
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

const detect = async (): Promise<GpuAcceleration | null> => {
  if (await probeNvidia()) {
    console.log("[GPU] NVIDIA CUDA/NVENC hardware acceleration available");
    return NVIDIA;
  }
  if (await probeAmd()) {
    console.log("[GPU] AMD AMF hardware acceleration available");
    return AMD;
  }
  console.log("[GPU] No hardware acceleration available, using software encoding");
  return null;
};

let gpuPromise: Promise<GpuAcceleration | null> | null = null;

export const getGpuAcceleration = (): Promise<GpuAcceleration | null> => {
  if (!gpuPromise) {
    gpuPromise = detect();
  }
  return gpuPromise;
};

export const resetGpuAccelerationForTests = (value: GpuAcceleration | null) => {
  gpuPromise = Promise.resolve(value);
};

export { NVIDIA, AMD };
export type { GpuAcceleration, GpuVendor };
