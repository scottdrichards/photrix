export const resolveDetectedImageAnalysisEnv = (
  env: NodeJS.ProcessEnv,
  options: { cudaAvailable: boolean; faceCudaAvailable: boolean },
): Partial<NodeJS.ProcessEnv> => {
  const updates: Partial<NodeJS.ProcessEnv> = {};

  if (!env.PHOTRIX_CLIP_DEVICE?.trim()) {
    updates.PHOTRIX_CLIP_DEVICE = options.cudaAvailable ? "cuda" : "cpu";
  }

  if (!env.PHOTRIX_INSIGHTFACE_PROVIDER?.trim() && !env.PHOTRIX_CLIP_PROVIDER?.trim()) {
    updates.PHOTRIX_INSIGHTFACE_PROVIDER =
      options.cudaAvailable && options.faceCudaAvailable
        ? "CUDAExecutionProvider"
        : "CPUExecutionProvider";
  }

  return updates;
};
