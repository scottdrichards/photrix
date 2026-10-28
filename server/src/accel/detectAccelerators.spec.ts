import { describe, expect, it } from "@jest/globals";
import { cpuOnlyReport, parseAcceleratorReport } from "./detectAccelerators.ts";

const probeLine = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    platform: "linux",
    machine: "x86_64",
    python: "3.14.0",
    torch: {
      device: "cuda",
      backend: "cuda",
      version: "2.9.1+cu126",
      rejected: {},
      error: null,
    },
    ort: {
      provider: "CUDAExecutionProvider",
      available: ["CUDAExecutionProvider", "CPUExecutionProvider"],
      version: "1.26.0",
      error: null,
    },
    ...overrides,
  });

describe("parseAcceleratorReport", () => {
  it("reads a full report", () => {
    const report = parseAcceleratorReport(probeLine() + "\n");
    expect(report.platform).toBe("linux");
    expect(report.torch).toEqual({
      device: "cuda",
      backend: "cuda",
      version: "2.9.1+cu126",
      rejected: {},
      error: null,
    });
    expect(report.ort.provider).toBe("CUDAExecutionProvider");
    expect(report.ort.available).toContain("CPUExecutionProvider");
  });

  it("uses the last JSON line, ignoring import noise before it", () => {
    const report = parseAcceleratorReport(
      `some banner\n{"not": "it"}\n${probeLine({ torch: { device: "mps" } })}\n`,
    );
    expect(report.torch.device).toBe("mps");
    expect(report.torch.backend).toBe("mps");
  });

  it("keeps the reasons a device was rejected", () => {
    const report = parseAcceleratorReport(
      probeLine({
        torch: {
          device: "cpu",
          rejected: { cuda: "RuntimeError: no kernel image is available", xpu: "not available" },
        },
      }),
    );
    expect(report.torch.device).toBe("cpu");
    expect(report.torch.rejected.cuda).toMatch(/no kernel image/);
  });

  it("reports ROCm under torch's cuda device", () => {
    const report = parseAcceleratorReport(
      probeLine({ torch: { device: "cuda", backend: "rocm" } }),
    );
    expect(report.torch).toMatchObject({ device: "cuda", backend: "rocm" });
  });

  it("falls back to CPU field by field when shapes are wrong", () => {
    const report = parseAcceleratorReport(
      JSON.stringify({ torch: { device: 7 }, ort: { available: "nope" } }),
    );
    expect(report.torch.device).toBe("cpu");
    expect(report.ort.provider).toBe("CPUExecutionProvider");
    expect(report.ort.available).toEqual([]);
  });

  it("falls back to CPU when there is no report at all", () => {
    expect(parseAcceleratorReport("").torch.device).toBe("cpu");
    expect(parseAcceleratorReport("{not json").torch.error).toMatch(/invalid JSON/);
  });
});

describe("cpuOnlyReport", () => {
  it("is all CPU and carries the reason", () => {
    const report = cpuOnlyReport("timed out");
    expect(report.torch.device).toBe("cpu");
    expect(report.ort.provider).toBe("CPUExecutionProvider");
    expect(report.torch.error).toBe("timed out");
  });
});
