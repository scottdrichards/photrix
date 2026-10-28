import {
  CPU_PROVIDER,
  CUDA_PROVIDER,
  type AcceleratorReport,
} from "../accel/detectAccelerators.ts";

/**
 * The device settings the ML workers start with, from the startup accelerator
 * report. An operator's explicit setting always wins: only unset variables are
 * filled in.
 *
 * - `PHOTRIX_TORCH_DEVICE`: the verified torch device, for any torch worker
 *   (CLAP reads it).
 * - `PHOTRIX_CLIP_DEVICE`: CLIP's device, the same verified torch device.
 * - `PHOTRIX_INSIGHTFACE_PROVIDER`: the face models' ONNX Runtime provider.
 *   The CUDA provider is used only when torch is on CUDA too, because its CUDA
 *   and cuDNN libraries come from torch's pip wheels (see
 *   `_preload_cuda_dlls`). Other providers bring their own runtime.
 */
export const resolveDetectedImageAnalysisEnv = (
  env: NodeJS.ProcessEnv,
  report: Pick<AcceleratorReport, "torch" | "ort">,
): Partial<NodeJS.ProcessEnv> => {
  const updates: Partial<NodeJS.ProcessEnv> = {};
  const torchDevice = report.torch.device;

  if (!env.PHOTRIX_TORCH_DEVICE?.trim()) {
    updates.PHOTRIX_TORCH_DEVICE = torchDevice;
  }

  if (!env.PHOTRIX_CLIP_DEVICE?.trim()) {
    updates.PHOTRIX_CLIP_DEVICE = torchDevice;
  }

  if (!env.PHOTRIX_INSIGHTFACE_PROVIDER?.trim() && !env.PHOTRIX_CLIP_PROVIDER?.trim()) {
    const provider = report.ort.provider;
    updates.PHOTRIX_INSIGHTFACE_PROVIDER =
      provider === CUDA_PROVIDER && torchDevice !== "cuda" ? CPU_PROVIDER : provider;
  }

  return updates;
};
