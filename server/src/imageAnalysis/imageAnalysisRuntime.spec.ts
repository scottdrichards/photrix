import { describe, expect, it } from "@jest/globals";
import type { AcceleratorReport } from "../accel/detectAccelerators.ts";
import { resolveDetectedImageAnalysisEnv } from "./imageAnalysisRuntime.ts";

const report = (
  device: string,
  provider: string,
): Pick<AcceleratorReport, "torch" | "ort"> => ({
  torch: { device, backend: device, version: null, rejected: {}, error: null },
  ort: { provider, available: [provider, "CPUExecutionProvider"], version: null, error: null },
});

describe("resolveDetectedImageAnalysisEnv", () => {
  it("puts CLIP and torch workers on the verified device", () => {
    expect(
      resolveDetectedImageAnalysisEnv({}, report("cuda", "CPUExecutionProvider")),
    ).toEqual({
      PHOTRIX_TORCH_DEVICE: "cuda",
      PHOTRIX_CLIP_DEVICE: "cuda",
      PHOTRIX_INSIGHTFACE_PROVIDER: "CPUExecutionProvider",
    });
  });

  it("uses the CUDA face provider alongside CUDA torch", () => {
    expect(
      resolveDetectedImageAnalysisEnv({}, report("cuda", "CUDAExecutionProvider")),
    ).toEqual({
      PHOTRIX_TORCH_DEVICE: "cuda",
      PHOTRIX_CLIP_DEVICE: "cuda",
      PHOTRIX_INSIGHTFACE_PROVIDER: "CUDAExecutionProvider",
    });
  });

  it("keeps the CUDA face provider off when torch couldn't use CUDA", () => {
    // Its CUDA libraries come from torch's wheels; without a working CUDA torch
    // the provider would fail to load anyway.
    expect(
      resolveDetectedImageAnalysisEnv({}, report("cpu", "CUDAExecutionProvider"))
        .PHOTRIX_INSIGHTFACE_PROVIDER,
    ).toBe("CPUExecutionProvider");
  });

  it.each([
    ["mps", "CoreMLExecutionProvider"],
    ["xpu", "OpenVINOExecutionProvider"],
    ["cpu", "DmlExecutionProvider"],
  ])("passes non-CUDA backends straight through (%s, %s)", (device, provider) => {
    expect(resolveDetectedImageAnalysisEnv({}, report(device, provider))).toEqual({
      PHOTRIX_TORCH_DEVICE: device,
      PHOTRIX_CLIP_DEVICE: device,
      PHOTRIX_INSIGHTFACE_PROVIDER: provider,
    });
  });

  it("does not override explicit operator settings", () => {
    expect(
      resolveDetectedImageAnalysisEnv(
        {
          PHOTRIX_TORCH_DEVICE: "cpu",
          PHOTRIX_CLIP_DEVICE: "cpu",
          PHOTRIX_INSIGHTFACE_PROVIDER: "CUDAExecutionProvider",
        },
        report("cuda", "CUDAExecutionProvider"),
      ),
    ).toEqual({});
  });

  it("preserves the legacy provider env without adding a new face override", () => {
    expect(
      resolveDetectedImageAnalysisEnv(
        { PHOTRIX_CLIP_PROVIDER: "CUDAExecutionProvider" },
        report("cuda", "CUDAExecutionProvider"),
      ),
    ).toEqual({
      PHOTRIX_TORCH_DEVICE: "cuda",
      PHOTRIX_CLIP_DEVICE: "cuda",
    });
  });
});
