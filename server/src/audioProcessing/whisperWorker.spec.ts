import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

type TimeoutEntry = {
  id: string;
  timeoutMs: number;
  onTimeout: () => void;
  cleared: boolean;
};

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
};

const access = jest.fn(async () => undefined);
const spawn = jest.fn();
const resolvePythonCommand = jest.fn(async () => "python3");
const buildPythonProcessEnv = jest.fn(async () => ({}));
const acquireGpuInitSlot = jest.fn(async () => () => {});
const registerComputeWorker = jest.fn();
const consumeDeliberateKill = jest.fn(() => false);
const markDeliberateKill = jest.fn();
let workerSuspended = false;
const isComputeWorkerSuspended = jest.fn(() => workerSuspended);
const markWorkerEvictedError = jest.fn((error: Error) => error);
const killAndAwaitExit = jest.fn(async () => {});
const timeouts: TimeoutEntry[] = [];
// Captured so tests can drive the orchestrator's freeze/thaw signal directly.
let suspensionListener: ((isSuspended: boolean) => void) | null = null;
const onComputeWorkerSuspensionChange = jest.fn(
  (_id: string, listener: (isSuspended: boolean) => void) => {
    suspensionListener = listener;
    return () => {
      suspensionListener = null;
    };
  },
);

jest.unstable_mockModule("node:fs/promises", () => ({ access }));
jest.unstable_mockModule("node:child_process", () => ({ spawn }));
jest.unstable_mockModule("../observability/logger.ts", () => ({
  getLogger: () => logger,
}));
jest.unstable_mockModule("../python/pythonRuntime.ts", () => ({
  resolvePythonCommand,
  buildPythonProcessEnv,
}));
jest.unstable_mockModule("../taskOrchestrator/computeWorkers.ts", () => ({
  COMPUTE_WORKER_IDS: { whisper: "whisper-audio" },
  registerComputeWorker,
  acquireGpuInitSlot,
  createSuspensionAwareTimeout: (id: string, timeoutMs: number, onTimeout: () => void) => {
    const entry: TimeoutEntry = { id, timeoutMs, onTimeout, cleared: false };
    timeouts.push(entry);
    return {
      clear: () => {
        entry.cleared = true;
      },
    };
  },
  consumeDeliberateKill,
  isComputeWorkerSuspended,
  killAndAwaitExit,
  markDeliberateKill,
  markWorkerEvictedError,
  onComputeWorkerSuspensionChange,
}));

const flush = async () => {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

const createFakeChild = () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new EventEmitter() as EventEmitter & {
    write: jest.Mock<(chunk: string) => boolean>;
  };
  stdin.write = jest.fn(() => true);

  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: typeof stdin;
    pid: number;
    kill: jest.Mock<() => void>;
  };
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = stdin;
  child.pid = 4242;
  child.kill = jest.fn();
  return child;
};

beforeEach(() => {
  logger.info.mockReset();
  logger.warn.mockReset();
  logger.debug.mockReset();
  logger.error.mockReset();
  access.mockClear();
  spawn.mockReset();
  resolvePythonCommand.mockClear();
  buildPythonProcessEnv.mockClear();
  acquireGpuInitSlot.mockClear();
  registerComputeWorker.mockClear();
  consumeDeliberateKill.mockClear();
  killAndAwaitExit.mockClear();
  markDeliberateKill.mockClear();
  markWorkerEvictedError.mockClear();
  onComputeWorkerSuspensionChange.mockClear();
  isComputeWorkerSuspended.mockClear();
  workerSuspended = false;
  // Most tests exercise behaviour unrelated to the start-hysteresis gate, so
  // disable it by default; the test that covers it sets its own value.
  process.env.PHOTRIX_WHISPER_START_QUIET_MS = "0";
  suspensionListener = null;
  timeouts.length = 0;
});

afterEach(() => {
  delete process.env.PHOTRIX_WHISPER_START_QUIET_MS;
  jest.resetModules();
  jest.restoreAllMocks();
});

describe("whisperWorker", () => {
  it("logs the ready device and CUDA fallback reason", async () => {
    const child = createFakeChild();
    spawn.mockReturnValue(child);
    child.stdin.write.mockImplementation(() => {
      child.stdout.write(JSON.stringify({ id: 1, segments: [] }) + "\n");
      return true;
    });

    const { transcribeWithWhisper } = await import("./whisperWorker.ts");
    const transcription = transcribeWithWhisper("/tmp/video.mp4");

    child.stdout.write(
      JSON.stringify({
        type: "ready",
        device: "cpu",
        fallbackFrom: "cuda",
        fallbackReason: "CUDA failed with error out of memory",
      }) + "\n",
    );

    await expect(transcription).resolves.toEqual([]);

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        device: "cpu",
        fallbackFrom: "cuda",
        fallbackReason: "CUDA failed with error out of memory",
      }),
      "Whisper worker ready",
    );
  });

  it("rejects promptly when the Python worker reports an init error", async () => {
    const child = createFakeChild();
    spawn.mockReturnValue(child);

    const { transcribeWithWhisper } = await import("./whisperWorker.ts");
    const transcription = transcribeWithWhisper("/tmp/video.mp4");

    child.stdout.write(
      JSON.stringify({ type: "error", error: "Whisper CUDA initialization failed" }) +
        "\n",
    );

    await expect(transcription).rejects.toThrow(
      "Whisper worker failed to initialise: Whisper CUDA initialization failed",
    );
  });

  it("logs request context and kills the worker when a request times out", async () => {
    const child = createFakeChild();
    spawn.mockReturnValue(child);

    const { transcribeWithWhisper } = await import("./whisperWorker.ts");
    const transcription = transcribeWithWhisper("/tmp/hung.mp4");

    child.stdout.write(JSON.stringify({ type: "ready", device: "cuda" }) + "\n");
    await flush();
    expect(child.stdin.write).toHaveBeenCalledTimes(1);

    const requestTimeout = timeouts.find((entry) => entry.timeoutMs === 30 * 60 * 1_000);
    expect(requestTimeout).toBeDefined();

    requestTimeout?.onTimeout();

    await expect(transcription).rejects.toThrow("Whisper worker timed out for request 1");
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 1,
        pid: 4242,
        operation: "transcribe",
        videoPath: "/tmp/hung.mp4",
        timeoutMs: 30 * 60 * 1_000,
      }),
      "Whisper worker timed out — killing process",
    );
  });

  it("scales the request timeout to the media duration", async () => {
    const child = createFakeChild();
    spawn.mockReturnValue(child);

    const { transcribeWithWhisper, transcriptionTimeoutMs } = await import(
      "./whisperWorker.ts"
    );

    // Unknown duration keeps the historical flat budget.
    expect(transcriptionTimeoutMs(undefined)).toBe(30 * 60 * 1_000);
    // Short media never drops below it either.
    expect(transcriptionTimeoutMs(30)).toBe(30 * 60 * 1_000);
    // A 40-minute video gets 3x realtime rather than a budget it cannot meet.
    expect(transcriptionTimeoutMs(40 * 60)).toBe(2 * 60 * 60 * 1_000);
    // ...but one pathological file cannot hold the single worker forever.
    expect(transcriptionTimeoutMs(24 * 60 * 60)).toBe(6 * 60 * 60 * 1_000);

    const transcription = transcribeWithWhisper("/tmp/long.mp4", 40 * 60);
    child.stdout.write(JSON.stringify({ type: "ready", device: "cpu" }) + "\n");
    await flush();

    expect(
      timeouts.some((entry) => entry.timeoutMs === 2 * 60 * 60 * 1_000),
    ).toBe(true);

    child.stdout.write(JSON.stringify({ id: 1, segments: [] }) + "\n");
    await expect(transcription).resolves.toEqual([]);
  });

  it("unloads the idle worker so its resident model is returned to the OS", async () => {
    jest.useFakeTimers();
    const child = createFakeChild();
    spawn.mockReturnValue(child);
    child.stdin.write.mockImplementation(() => {
      child.stdout.write(JSON.stringify({ id: 1, segments: [] }) + "\n");
      return true;
    });

    const { transcribeWithWhisper } = await import("./whisperWorker.ts");
    const transcription = transcribeWithWhisper("/tmp/video.mp4");
    child.stdout.write(JSON.stringify({ type: "ready", device: "cpu" }) + "\n");
    await expect(transcription).resolves.toEqual([]);

    // Still resident immediately after the request settles.
    expect(child.kill).not.toHaveBeenCalled();

    jest.advanceTimersByTime(60_000);

    expect(markDeliberateKill).toHaveBeenCalledWith(4242);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    jest.useRealTimers();
  });

  it("kills the worker at once when frozen, discarding in-flight work", async () => {
    const child = createFakeChild();
    spawn.mockReturnValue(child);
    // Never answers — the transcription is still running when the user arrives.
    child.stdin.write.mockImplementation(() => true);

    const { transcribeWithWhisper } = await import("./whisperWorker.ts");
    const transcription = transcribeWithWhisper("/tmp/slow.mp4");
    child.stdout.write(JSON.stringify({ type: "ready", device: "cpu" }) + "\n");
    await flush();
    expect(child.stdin.write).toHaveBeenCalledTimes(1);

    // The orchestrator freezes us for a user request. No grace period: the
    // in-flight file is abandoned rather than waited on.
    suspensionListener?.(true);

    expect(markDeliberateKill).toHaveBeenCalledWith(4242);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        pid: 4242,
        reason: "suspended for user request",
        discardedRequests: 1,
      }),
      "Unloading Whisper worker to release memory",
    );

    // The abandoned request rejects rather than hanging, so the task runner can
    // requeue it.
    child.emit("exit", null, "SIGKILL");
    await expect(transcription).rejects.toThrow("Whisper worker exited");
  });

  it("refuses to start at all inside an active user-request window", async () => {
    // Loading the model costs ~30s and ~2.2 GB, and a request only enters
    // `pending` once the load finishes — so spawning here and killing moments
    // later would discard nothing while paying the full cost, producing a
    // respawn loop that never completes a transcription.
    workerSuspended = true;
    const child = createFakeChild();
    spawn.mockReturnValue(child);

    const { transcribeWithWhisper } = await import("./whisperWorker.ts");

    await expect(transcribeWithWhisper("/tmp/video.mp4")).rejects.toThrow(
      "Whisper worker not started",
    );
    expect(spawn).not.toHaveBeenCalled();
    // Tagged as an eviction so the task runner requeues rather than erroring.
    expect(markWorkerEvictedError).toHaveBeenCalled();
  });

  it("starts normally once the user-request window has lapsed", async () => {
    workerSuspended = false;
    const child = createFakeChild();
    spawn.mockReturnValue(child);
    child.stdin.write.mockImplementation(() => {
      child.stdout.write(JSON.stringify({ id: 1, segments: [] }) + "\n");
      return true;
    });

    const { transcribeWithWhisper } = await import("./whisperWorker.ts");
    const transcription = transcribeWithWhisper("/tmp/video.mp4");
    child.stdout.write(JSON.stringify({ type: "ready", device: "cpu" }) + "\n");

    await expect(transcription).resolves.toEqual([]);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("will not pay for a model load until the box has been quiet a while", async () => {
    // A 2s orchestrator cooldown means background resumes between keystrokes;
    // starting a ~30s / 2.2 GB load in that gap only to be killed by the next
    // request is pure waste, so the start decision uses a longer horizon.
    process.env.PHOTRIX_WHISPER_START_QUIET_MS = "60000";
    const child = createFakeChild();
    spawn.mockReturnValue(child);

    const { transcribeWithWhisper } = await import("./whisperWorker.ts");

    await expect(transcribeWithWhisper("/tmp/video.mp4")).rejects.toThrow(
      "of quiet",
    );
    expect(spawn).not.toHaveBeenCalled();
    expect(markWorkerEvictedError).toHaveBeenCalled();
  });

  it("keeps refusing while browsing continues, even without new suspend edges", async () => {
    // Anchoring to the suspend edge was the bug: under continuous browsing the
    // orchestrator stays suspended, so no further suspend edges arrive and a
    // suspend-anchored timestamp ages past any threshold. Anchor on resume.
    process.env.PHOTRIX_WHISPER_START_QUIET_MS = "60000";
    const child = createFakeChild();
    spawn.mockReturnValue(child);

    const { transcribeWithWhisper } = await import("./whisperWorker.ts");

    // One suspend edge, then nothing further — the user keeps browsing.
    suspensionListener?.(true);
    jest.useFakeTimers();
    jest.advanceTimersByTime(10 * 60_000); // ten minutes without a resume edge
    jest.useRealTimers();

    await expect(transcribeWithWhisper("/tmp/video.mp4")).rejects.toThrow(
      /not started/,
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("starts once a full quiet stretch has elapsed since activity ended", async () => {
    process.env.PHOTRIX_WHISPER_START_QUIET_MS = "50";
    const child = createFakeChild();
    spawn.mockReturnValue(child);
    child.stdin.write.mockImplementation(() => {
      child.stdout.write(JSON.stringify({ id: 1, segments: [] }) + "\n");
      return true;
    });

    const { transcribeWithWhisper } = await import("./whisperWorker.ts");

    suspensionListener?.(true); // user active
    suspensionListener?.(false); // window lapsed — quiet begins here
    await new Promise((resolve) => setTimeout(resolve, 80));

    const transcription = transcribeWithWhisper("/tmp/video.mp4");
    child.stdout.write(JSON.stringify({ type: "ready", device: "cpu" }) + "\n");
    await expect(transcription).resolves.toEqual([]);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("does not unload on the idle timer while a transcription is in flight", async () => {
    const child = createFakeChild();
    spawn.mockReturnValue(child);
    child.stdin.write.mockImplementation(() => true);

    const { transcribeWithWhisper } = await import("./whisperWorker.ts");
    void transcribeWithWhisper("/tmp/slow.mp4");
    child.stdout.write(JSON.stringify({ type: "ready", device: "cpu" }) + "\n");
    // flush() drives real setImmediate, so it must run before timers are faked.
    await flush();
    expect(child.stdin.write).toHaveBeenCalledTimes(1);

    jest.useFakeTimers();
    jest.advanceTimersByTime(600_000);

    expect(child.kill).not.toHaveBeenCalled();
    jest.useRealTimers();
  });
});
