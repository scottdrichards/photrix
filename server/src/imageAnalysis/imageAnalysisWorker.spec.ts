import { describe, expect, it } from "@jest/globals";
import { resolveImageAnalysisWorkerRuntime } from "./imageAnalysisWorker.ts";

describe("resolveImageAnalysisWorkerRuntime", () => {
  it("defaults to CPU for both face provider and CLIP device", () => {
    expect(resolveImageAnalysisWorkerRuntime({})).toEqual({
      faceProvider: "CPUExecutionProvider",
      clipDevice: "cpu",
    });
  });

  it("prefers the explicit InsightFace provider and CLIP device", () => {
    expect(
      resolveImageAnalysisWorkerRuntime({
        PHOTRIX_INSIGHTFACE_PROVIDER: "CUDAExecutionProvider",
        PHOTRIX_CLIP_DEVICE: "cuda",
      }),
    ).toEqual({
      faceProvider: "CUDAExecutionProvider",
      clipDevice: "cuda",
    });
  });

  it("falls back to the legacy provider env var when InsightFace is unset", () => {
    expect(
      resolveImageAnalysisWorkerRuntime({
        PHOTRIX_CLIP_PROVIDER: "CUDAExecutionProvider",
      }),
    ).toEqual({
      faceProvider: "CUDAExecutionProvider",
      clipDevice: "cpu",
    });
  });
});
