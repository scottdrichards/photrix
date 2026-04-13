import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { EventEmitter } from "node:events";

const makeSpawnProcess = () => {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
};

afterEach(() => {
  jest.resetModules();
  jest.restoreAllMocks();
});

describe("gpuAcceleration", () => {
  it("returns NVIDIA config when CUDA probe succeeds", async () => {
    const spawnMock = jest.fn((_cmd: string, args: string[]) => {
      const proc = makeSpawnProcess();
      queueMicrotask(() => {
        if (args.includes("-init_hw_device")) {
          proc.emit("close", 0);
          return;
        }
        proc.emit("close", 1);
      });
      return proc;
    });
    jest.unstable_mockModule("child_process", () => ({ spawn: spawnMock }));

    const { getGpuAcceleration } = await import("./gpuAcceleration.ts");
    const gpu = await getGpuAcceleration();

    expect(gpu).not.toBeNull();
    expect(gpu!.vendor).toBe("nvidia");
    expect(gpu!.h264Codec).toBe("h264_nvenc");
    expect(gpu!.hwaccelArgs).toContain("-hwaccel");
    expect(gpu!.label).toContain("NVIDIA");
  });

  it("returns AMD config when CUDA fails but AMF probe succeeds", async () => {
    const spawnMock = jest.fn((_cmd: string, args: string[]) => {
      const proc = makeSpawnProcess();
      queueMicrotask(() => {
        if (args.includes("-init_hw_device")) {
          proc.stderr.emit("data", Buffer.from("Could not dynamically load CUDA"));
          proc.emit("close", 1);
          return;
        }
        if (args.includes("h264_amf")) {
          proc.emit("close", 0);
          return;
        }
        proc.emit("close", 1);
      });
      return proc;
    });
    jest.unstable_mockModule("child_process", () => ({ spawn: spawnMock }));

    const { getGpuAcceleration } = await import("./gpuAcceleration.ts");
    const gpu = await getGpuAcceleration();

    expect(gpu).not.toBeNull();
    expect(gpu!.vendor).toBe("amd");
    expect(gpu!.h264Codec).toBe("h264_amf");
    expect(gpu!.hwaccelArgs).toEqual([]);
    expect(gpu!.label).toContain("AMD");
  });

  it("returns null when both probes fail", async () => {
    const spawnMock = jest.fn(() => {
      const proc = makeSpawnProcess();
      queueMicrotask(() => proc.emit("close", 1));
      return proc;
    });
    jest.unstable_mockModule("child_process", () => ({ spawn: spawnMock }));

    const { getGpuAcceleration } = await import("./gpuAcceleration.ts");
    const gpu = await getGpuAcceleration();

    expect(gpu).toBeNull();
  });

  it("memoizes the result across calls", async () => {
    const spawnMock = jest.fn(() => {
      const proc = makeSpawnProcess();
      queueMicrotask(() => proc.emit("close", 0));
      return proc;
    });
    jest.unstable_mockModule("child_process", () => ({ spawn: spawnMock }));

    const { getGpuAcceleration } = await import("./gpuAcceleration.ts");
    const first = await getGpuAcceleration();
    const second = await getGpuAcceleration();

    expect(first).toBe(second);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("resetGpuAccelerationForTests overrides the cached value", async () => {
    const spawnMock = jest.fn(() => {
      const proc = makeSpawnProcess();
      queueMicrotask(() => proc.emit("close", 1));
      return proc;
    });
    jest.unstable_mockModule("child_process", () => ({ spawn: spawnMock }));

    const { getGpuAcceleration, resetGpuAccelerationForTests, AMD } = await import(
      "./gpuAcceleration.ts"
    );

    expect(await getGpuAcceleration()).toBeNull();

    resetGpuAccelerationForTests(AMD);
    expect(await getGpuAcceleration()).toBe(AMD);

    resetGpuAccelerationForTests(null);
    expect(await getGpuAcceleration()).toBeNull();
  });

  it("NVIDIA.isHardwareFailure detects CUDA errors", async () => {
    const { NVIDIA } = await import("./gpuAcceleration.ts");
    expect(NVIDIA.isHardwareFailure("Cannot load nvcuda.dll")).toBe(true);
    expect(NVIDIA.isHardwareFailure("CUDA initialization failed")).toBe(true);
    expect(NVIDIA.isHardwareFailure("h264_nvenc not found")).toBe(true);
    expect(NVIDIA.isHardwareFailure("generic error")).toBe(false);
  });

  it("AMD.isHardwareFailure detects AMF errors", async () => {
    const { AMD } = await import("./gpuAcceleration.ts");
    expect(AMD.isHardwareFailure("Failed to create AMF context")).toBe(true);
    expect(AMD.isHardwareFailure("h264_amf encoder error")).toBe(true);
    expect(AMD.isHardwareFailure("DirectX device failed")).toBe(true);
    expect(AMD.isHardwareFailure("generic error")).toBe(false);
  });

  it("cqArgs and vbrArgs produce correct encoder-specific arguments", async () => {
    const { NVIDIA, AMD } = await import("./gpuAcceleration.ts");

    const nvCq = NVIDIA.cqArgs(28);
    expect(nvCq).toContain("-cq");
    expect(nvCq).toContain("28");
    expect(nvCq).toContain("-b:v");
    expect(nvCq).toContain("0");

    const amdCq = AMD.cqArgs(26);
    expect(amdCq).toContain("-qp_i");
    expect(amdCq).toContain("26");
    expect(amdCq).toContain("-rc");
    expect(amdCq).toContain("cqp");

    const nvVbr = NVIDIA.vbrArgs(28);
    expect(nvVbr).toContain("-cq");
    expect(nvVbr).not.toContain("-b:v");

    const amdVbr = AMD.vbrArgs(28);
    expect(amdVbr).toContain("-rc");
    expect(amdVbr).toContain("vbr_peak");
  });

  it("handles spawn error gracefully", async () => {
    const spawnMock = jest.fn(() => {
      const proc = makeSpawnProcess();
      queueMicrotask(() => proc.emit("error", new Error("spawn failed")));
      return proc;
    });
    jest.unstable_mockModule("child_process", () => ({ spawn: spawnMock }));

    const { getGpuAcceleration } = await import("./gpuAcceleration.ts");
    const gpu = await getGpuAcceleration();

    expect(gpu).toBeNull();
  });
});
