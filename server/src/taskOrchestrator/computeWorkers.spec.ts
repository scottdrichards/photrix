import { afterEach, describe, expect, it, jest } from "@jest/globals";

jest.unstable_mockModule("../observability/logger.ts", () => ({
  getLogger: () => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  }),
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

const {
  registerComputeWorker,
  unregisterComputeWorker,
  withForegroundWorker,
  awaitForegroundIdle,
  suspendComputeWorkers,
  resumeComputeWorkers,
  createSuspensionAwareTimeout,
  getComputeWorkerPids,
  reclaimGpuForUser,
  releaseGpuReclaim,
  isGpuReclaimed,
  roleForComputeWorkerId,
  COMPUTE_WORKER_IDS,
} = await import("./computeWorkers.ts");

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

afterEach(() => {
  resumeComputeWorkers();
  releaseGpuReclaim();
  jest.useRealTimers();
});

describe("computeWorkers foreground-idle gate", () => {
  it("resolves immediately when no foreground call is in flight", async () => {
    registerComputeWorker("idle-worker", () => null);
    let resolved = false;
    void awaitForegroundIdle("idle-worker").then(() => {
      resolved = true;
    });
    await tick();
    expect(resolved).toBe(true);
  });

  it("blocks background work until the foreground call completes", async () => {
    registerComputeWorker("busy-worker", () => null);

    let releaseForeground!: () => void;
    const foregroundBody = new Promise<void>((resolve) => {
      releaseForeground = resolve;
    });
    const foreground = withForegroundWorker("busy-worker", () => foregroundBody);

    // Background work requested while the foreground call is in flight must wait.
    let backgroundProceeded = false;
    const background = awaitForegroundIdle("busy-worker").then(() => {
      backgroundProceeded = true;
    });

    await tick();
    expect(backgroundProceeded).toBe(false);

    releaseForeground();
    await foreground;
    await background;
    expect(backgroundProceeded).toBe(true);
  });

  it("keeps the gate closed until the last concurrent foreground call finishes", async () => {
    registerComputeWorker("multi-worker", () => null);

    let releaseA!: () => void;
    let releaseB!: () => void;
    const a = withForegroundWorker(
      "multi-worker",
      () => new Promise<void>((r) => (releaseA = r)),
    );
    const b = withForegroundWorker(
      "multi-worker",
      () => new Promise<void>((r) => (releaseB = r)),
    );

    let backgroundProceeded = false;
    void awaitForegroundIdle("multi-worker").then(() => {
      backgroundProceeded = true;
    });

    releaseA();
    await a;
    await tick();
    // One foreground call is still in flight, so the gate stays closed.
    expect(backgroundProceeded).toBe(false);

    releaseB();
    await b;
    await tick();
    expect(backgroundProceeded).toBe(true);
  });

  it("pauses timeout accounting while the worker is suspended", () => {
    jest.useFakeTimers();
    registerComputeWorker("timer-worker", () => null);

    const onTimeout = jest.fn();
    const timeout = createSuspensionAwareTimeout("timer-worker", 100, onTimeout);

    jest.advanceTimersByTime(60);
    expect(onTimeout).not.toHaveBeenCalled();

    suspendComputeWorkers();
    jest.advanceTimersByTime(5_000);
    expect(onTimeout).not.toHaveBeenCalled();

    resumeComputeWorkers();
    jest.advanceTimersByTime(39);
    expect(onTimeout).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);

    timeout.clear();
    unregisterComputeWorker("timer-worker");
  });

  it("keeps timeout accounting running while a foreground lease pins the worker awake", async () => {
    jest.useFakeTimers();
    registerComputeWorker("foreground-timer-worker", () => null);

    let releaseForeground!: () => void;
    const foreground = withForegroundWorker(
      "foreground-timer-worker",
      () =>
        new Promise<void>((resolve) => {
          releaseForeground = resolve;
        }),
    );

    const onTimeout = jest.fn();
    const timeout = createSuspensionAwareTimeout(
      "foreground-timer-worker",
      100,
      onTimeout,
    );

    suspendComputeWorkers();
    jest.advanceTimersByTime(100);
    expect(onTimeout).toHaveBeenCalledTimes(1);

    timeout.clear();
    releaseForeground();
    await foreground;
    unregisterComputeWorker("foreground-timer-worker");
  });
});

describe("computeWorkers GPU reclaim", () => {
  it("kills leaseless workers and marks the GPU reclaimed, sparing leased workers", async () => {
    const killSpy = jest
      .spyOn(process, "kill")
      .mockImplementation(() => true as unknown as boolean);

    registerComputeWorker("reclaim-idle", () => 424242);
    registerComputeWorker("reclaim-busy", () => 434343);

    // Pin reclaim-busy awake with a foreground lease; it must not be killed.
    let releaseForeground!: () => void;
    const foreground = withForegroundWorker(
      "reclaim-busy",
      () => new Promise<void>((resolve) => (releaseForeground = resolve)),
    );

    expect(isGpuReclaimed()).toBe(false);
    reclaimGpuForUser();
    expect(isGpuReclaimed()).toBe(true);

    const killedPids = killSpy.mock.calls
      .filter(([, sig]) => sig === "SIGKILL")
      .map(([pid]) => pid);
    expect(killedPids).toContain(424242);
    expect(killedPids).not.toContain(434343);

    releaseGpuReclaim();
    expect(isGpuReclaimed()).toBe(false);

    releaseForeground();
    await foreground;
    unregisterComputeWorker("reclaim-idle");
    unregisterComputeWorker("reclaim-busy");
    killSpy.mockRestore();
  });

  it("reports registered workers with live pids and role tags", () => {
    registerComputeWorker(COMPUTE_WORKER_IDS.whisper, () => 515151);
    registerComputeWorker("no-pid-worker", () => null);

    const pids = getComputeWorkerPids();
    const whisper = pids.find((w) => w.pid === 515151);
    expect(whisper).toBeDefined();
    expect(whisper?.role).toBe("whisper");
    // A worker without a live pid is omitted.
    expect(pids.some((w) => w.id === "no-pid-worker")).toBe(false);

    expect(roleForComputeWorkerId(COMPUTE_WORKER_IDS.clap)).toBe("clap");
    expect(roleForComputeWorkerId("unknown")).toBeUndefined();

    unregisterComputeWorker(COMPUTE_WORKER_IDS.whisper);
    unregisterComputeWorker("no-pid-worker");
  });
});
