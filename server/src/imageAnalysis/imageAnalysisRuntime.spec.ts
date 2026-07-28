import { describe, expect, it } from "@jest/globals";
import { resolveDetectedImageAnalysisEnv } from "./imageAnalysisRuntime.ts";

describe("resolveDetectedImageAnalysisEnv", () => {
  it("defaults CLIP to CUDA when available", () => {
    expect(
      resolveDetectedImageAnalysisEnv(
        {},
        { cudaAvailable: true, faceCudaAvailable: false },
      ),
    ).toEqual({
      PHOTRIX_CLIP_DEVICE: "cuda",
      PHOTRIX_INSIGHTFACE_PROVIDER: "CPUExecutionProvider",
    });
  });

  it("enables CUDA InsightFace only when the CUDA provider is available", () => {
    expect(
      resolveDetectedImageAnalysisEnv(
        {},
        { cudaAvailable: true, faceCudaAvailable: true },
      ),
    ).toEqual({
      PHOTRIX_CLIP_DEVICE: "cuda",
      PHOTRIX_INSIGHTFACE_PROVIDER: "CUDAExecutionProvider",
    });
  });

  it("does not override explicit operator settings", () => {
    expect(
      resolveDetectedImageAnalysisEnv(
        {
          PHOTRIX_CLIP_DEVICE: "cpu",
          PHOTRIX_INSIGHTFACE_PROVIDER: "CUDAExecutionProvider",
        },
        { cudaAvailable: true, faceCudaAvailable: true },
      ),
    ).toEqual({});
  });

  it("preserves the legacy provider env without adding a new face override", () => {
    expect(
      resolveDetectedImageAnalysisEnv(
        {
          PHOTRIX_CLIP_PROVIDER: "CUDAExecutionProvider",
        },
        { cudaAvailable: true, faceCudaAvailable: true },
      ),
    ).toEqual({
      PHOTRIX_CLIP_DEVICE: "cuda",
    });
  });
});
