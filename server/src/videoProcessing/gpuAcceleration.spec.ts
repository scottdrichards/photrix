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
  it("returns NVIDIA config when the CUDA and NVENC probes both succeed", async () => {
    const spawnMock = jest.fn((_cmd: string, args: string[]) => {
      const proc = makeSpawnProcess();
      queueMicrotask(() => {
        // CUDA initialises and the card has a working encoder behind it.
        if (args.includes("-init_hw_device") || args.includes("h264_nvenc")) {
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

  it("returns NVIDIA config when CUDA probe fails on exhausted VRAM (OOM)", async () => {
    const spawnMock = jest.fn((_cmd: string, args: string[]) => {
      const proc = makeSpawnProcess();
      queueMicrotask(() => {
        // A full card fails both probes the same way: out of memory, not absent.
        if (args.includes("-init_hw_device") || args.includes("h264_nvenc")) {
          proc.stderr.emit(
            "data",
            Buffer.from("cuCtxCreate failed -> CUDA_ERROR_OUT_OF_MEMORY: out of memory"),
          );
          proc.emit("close", 1);
          return;
        }
        proc.emit("close", 1);
      });
      return proc;
    });
    jest.unstable_mockModule("child_process", () => ({ spawn: spawnMock }));

    const { getGpuAcceleration } = await import("./gpuAcceleration.ts");
    const gpu = await getGpuAcceleration();

    // A full card is present-but-busy, not absent: still NVIDIA so HLS is offered
    // and the encoder reclaims VRAM. AMF is never probed.
    expect(gpu).not.toBeNull();
    expect(gpu!.vendor).toBe("nvidia");
    // Only the two NVIDIA probes ran — AMD and Intel are never reached.
    expect(spawnMock).toHaveBeenCalledTimes(2);
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
    expect(gpu!.hwaccelArgs).toEqual(["-hwaccel", "d3d11va"]);
    expect(gpu!.label).toContain("AMD");
  });

  it("returns Intel config when CUDA and AMF probes fail but VAAPI probe succeeds", async () => {
    const spawnMock = jest.fn((_cmd: string, args: string[]) => {
      const proc = makeSpawnProcess();
      queueMicrotask(() => {
        if (args.includes("-init_hw_device")) {
          proc.stderr.emit("data", Buffer.from("Could not dynamically load CUDA"));
          proc.emit("close", 1);
          return;
        }
        if (args.includes("h264_amf")) {
          proc.emit("close", 1);
          return;
        }
        if (args.includes("h264_vaapi")) {
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
    expect(gpu!.vendor).toBe("intel");
    expect(gpu!.h264Codec).toBe("h264_vaapi");
    // Hardware decode (-hwaccel vaapi, frames back to system memory so CPU
    // filters/auto-rotate still run) plus the device the encoder uploads to.
    expect(gpu!.hwaccelArgs).toEqual([
      "-hwaccel",
      "vaapi",
      "-hwaccel_device",
      "/dev/dri/renderD128",
      "-vaapi_device",
      "/dev/dri/renderD128",
    ]);
    expect(gpu!.vfExtra).toBe(",format=nv12,hwupload");
    expect(gpu!.label).toContain("Intel");
  });

  it("skips a CUDA-capable card that has no NVENC, falling through to Intel", async () => {
    // server2's Quadro P520 (GP108): CUDA initialises fine, but the silicon has
    // no encoder, so h264_nvenc fails with "No capable devices found".
    // Selecting NVIDIA here would send every encode into the software fallback.
    const spawnMock = jest.fn((_cmd: string, args: string[]) => {
      const proc = makeSpawnProcess();
      queueMicrotask(() => {
        if (args.includes("-init_hw_device")) {
          proc.emit("close", 0); // CUDA works
          return;
        }
        if (args.includes("h264_nvenc")) {
          proc.stderr.emit(
            "data",
            Buffer.from("OpenEncodeSessionEx failed: unsupported device (2)\nNo capable devices found"),
          );
          proc.emit("close", 1);
          return;
        }
        if (args.includes("h264_amf")) {
          proc.emit("close", 1);
          return;
        }
        proc.emit("close", 0); // VAAPI probes succeed
      });
      return proc;
    });
    jest.unstable_mockModule("child_process", () => ({ spawn: spawnMock }));

    const { getGpuAcceleration } = await import("./gpuAcceleration.ts");
    const gpu = await getGpuAcceleration();

    expect(gpu!.vendor).toBe("intel");
    expect(gpu!.h264Codec).toBe("h264_vaapi");
  });

  it("keeps NVIDIA when the encoder is merely out of VRAM", async () => {
    // Distinct from the no-encoder case: the encoder exists, VRAM is full right
    // now, and ensureGpuHeadroom reclaims it from background workers at encode
    // time. Treating this as "no GPU" would drop playback to the iGPU or worse.
    const spawnMock = jest.fn((_cmd: string, args: string[]) => {
      const proc = makeSpawnProcess();
      queueMicrotask(() => {
        if (args.includes("-init_hw_device")) {
          proc.emit("close", 0);
          return;
        }
        if (args.includes("h264_nvenc")) {
          proc.stderr.emit("data", Buffer.from("OpenEncodeSessionEx failed: out of memory"));
          proc.emit("close", 1);
          return;
        }
        proc.emit("close", 0);
      });
      return proc;
    });
    jest.unstable_mockModule("child_process", () => ({ spawn: spawnMock }));

    const { getGpuAcceleration } = await import("./gpuAcceleration.ts");
    const gpu = await getGpuAcceleration();

    expect(gpu!.vendor).toBe("nvidia");
  });

  it("reports on-GPU scaling and VBR according to what the driver answers", async () => {
    // Same silicon, stripped driver: encode works, but scale_vaapi and VBR
    // both fail. Debian's DFSG-repacked intel-media-va-driver behaves this way.
    const makeIntelProbes = (accept: (args: string[]) => boolean) =>
      jest.fn((_cmd: string, args: string[]) => {
        const proc = makeSpawnProcess();
        queueMicrotask(() => {
          if (args.includes("-init_hw_device") || args.includes("h264_amf")) {
            proc.emit("close", 1);
            return;
          }
          proc.emit("close", accept(args) ? 0 : 1);
        });
        return proc;
      });

    const strippedDriver = makeIntelProbes(
      (args) => !args.some((a) => a.includes("scale_vaapi")) && !args.includes("VBR"),
    );
    jest.unstable_mockModule("child_process", () => ({ spawn: strippedDriver }));
    const stripped = await (await import("./gpuAcceleration.ts")).getGpuAcceleration();

    expect(stripped!.vendor).toBe("intel");
    expect(stripped!.supportsVideoProc).toBe(false);
    // Falls back to the rate-control mode a low-power-only encoder accepts.
    expect(stripped!.vbrArgs(28)).toEqual(["-rc_mode", "CQP", "-qp", "28"]);

    jest.resetModules();

    const fullDriver = makeIntelProbes(() => true);
    jest.unstable_mockModule("child_process", () => ({ spawn: fullDriver }));
    const full = await (await import("./gpuAcceleration.ts")).getGpuAcceleration();

    expect(full!.supportsVideoProc).toBe(true);
    expect(full!.vbrArgs(28)).toEqual(["-rc_mode", "VBR"]);
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
    // Probed once (CUDA, then NVENC to confirm an encoder exists) and cached:
    // the second call spawns nothing.
    expect(spawnMock).toHaveBeenCalledTimes(2);
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

  it("INTEL.isHardwareFailure detects VAAPI errors", async () => {
    const { INTEL } = await import("./gpuAcceleration.ts");
    expect(INTEL.isHardwareFailure("Failed to initialise VAAPI connection")).toBe(true);
    expect(INTEL.isHardwareFailure("h264_vaapi encoder error")).toBe(true);
    expect(INTEL.isHardwareFailure("Cannot open /dev/dri/renderD128")).toBe(true);
    expect(INTEL.isHardwareFailure("generic error")).toBe(false);
  });

  it("cqArgs and vbrArgs produce correct encoder-specific arguments", async () => {
    const { NVIDIA, AMD, INTEL } = await import("./gpuAcceleration.ts");

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

    const intelCq = INTEL.cqArgs(26);
    expect(intelCq).toContain("-qp");
    expect(intelCq).toContain("26");
    expect(intelCq).toContain("-rc_mode");
    expect(intelCq).toContain("CQP");

    const nvVbr = NVIDIA.vbrArgs(28);
    expect(nvVbr).toContain("-cq");
    expect(nvVbr).not.toContain("-b:v");

    const amdVbr = AMD.vbrArgs(28);
    expect(amdVbr).toContain("-rc");
    expect(amdVbr).toContain("vbr_peak");

    // Intel deliberately reports CQP for both: the only H.264 entrypoint this
    // hardware exposes (low-power) rejects VBR outright, which failed the encode.
    const intelVbr = INTEL.vbrArgs(28);
    expect(intelVbr).toContain("-rc_mode");
    expect(intelVbr).toContain("CQP");
    expect(intelVbr).not.toContain("VBR");
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
