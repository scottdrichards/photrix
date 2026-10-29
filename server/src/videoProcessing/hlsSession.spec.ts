import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

// A minimal fake ffmpeg process: an EventEmitter with a spy-able kill().
const makeChild = () => {
  const child = new EventEmitter() as EventEmitter & ChildProcess & { kill: jest.Mock };
  child.kill = jest.fn(() => true);
  return child;
};

// Fresh module state (and a controllable variant-idle window) per test.
const loadSession = async (idleMs = 10_000) => {
  jest.resetModules();
  process.env.PHOTRIX_HLS_VARIANT_IDLE_MS = String(idleMs);
  return import("./hlsSession.ts");
};

afterEach(() => {
  jest.useRealTimers();
  delete process.env.PHOTRIX_HLS_VARIANT_IDLE_MS;
});

describe("claimVariantEncode", () => {
  it("returns the start segment on first claim, then null while encode is live", async () => {
    const { claimVariantEncode, registerHlsProcess } = await loadSession();
    const dir = "/hls/a";

    // First request for a variant starts an encode.
    expect(claimVariantEncode(dir, 720)).toBe(0);
    registerHlsProcess(dir, 720, makeChild());

    // Subsequent requests while encode is live must NOT restart it — that would
    // double-spawn into the same directory.
    expect(claimVariantEncode(dir, 720)).toBeNull();
    expect(claimVariantEncode(dir, 720)).toBeNull();
  });

  it("starts an independent encode per variant (ABR variant switch)", async () => {
    const { claimVariantEncode } = await loadSession();
    const dir = "/hls/b";

    expect(claimVariantEncode(dir, 360)).toBe(0);
    // Switching up to 720p mid-stream: a new variant with no encode starts one.
    expect(claimVariantEncode(dir, 720)).toBe(0);
    // Subsequent 720p requests are covered by the running encode.
    expect(claimVariantEncode(dir, 720)).toBeNull();
  });

  it("restarts once the encode process has exited, then not again while live", async () => {
    const { claimVariantEncode, registerHlsProcess } = await loadSession();
    const dir = "/hls/d";

    expect(claimVariantEncode(dir, 720)).toBe(0);
    const child = makeChild();
    registerHlsProcess(dir, 720, child);
    expect(claimVariantEncode(dir, 720)).toBeNull(); // still running

    child.emit("exit"); // encoder finished/crashed → slot is dead
    expect(claimVariantEncode(dir, 720)).toBe(0); // needs restart
    registerHlsProcess(dir, 720, makeChild());
    expect(claimVariantEncode(dir, 720)).toBeNull(); // live again
  });

  it("reaps an idle variant's encode and restarts on re-selection", async () => {
    jest.useFakeTimers();
    const { claimVariantEncode, registerHlsProcess, touchVariant } =
      await loadSession(50);
    const dir = "/hls/e";

    expect(claimVariantEncode(dir, 360)).toBe(0);
    const child = makeChild();
    registerHlsProcess(dir, 360, child);
    touchVariant(dir, 360);

    // No fetches for this variant past the idle window (ABR switched away) → killed.
    jest.advanceTimersByTime(60);
    expect(child.kill).toHaveBeenCalled();

    // Re-selecting it later restarts the encode.
    expect(claimVariantEncode(dir, 360)).toBe(0);
  });
});


describe("seeking (feedback #167)", () => {
  // Segments 0..head are on disk.
  const onDiskThrough = (head: number) => (index: number) => index <= head;

  it("starts a new encode at a segment far past the head instead of waiting", async () => {
    const { claimVariantEncode, registerHlsProcess, SEEK_RESTART_GAP_SEGMENTS } =
      await loadSession();
    const dir = "/hls/seek-a";
    expect(claimVariantEncode(dir, 720, 0)).toBe(0);
    const fromZero = makeChild();
    registerHlsProcess(dir, 720, fromZero);

    // Scrubbing to 7:00 while the encode from 0:00 is at 0:30.
    expect(claimVariantEncode(dir, 720, 420, onDiskThrough(30))).toBe(420);
    expect(fromZero.kill).toHaveBeenCalled();
    registerHlsProcess(dir, 720, makeChild());

    // The next segments come from the new encode.
    expect(claimVariantEncode(dir, 720, 421, onDiskThrough(30))).toBeNull();
    // Nothing of it is on disk yet: its head is 419.
    expect(claimVariantEncode(dir, 720, 419 + SEEK_RESTART_GAP_SEGMENTS, onDiskThrough(30))).toBeNull();
  });

  it("waits for the running encode when the request is just past its head", async () => {
    const { claimVariantEncode, registerHlsProcess, SEEK_RESTART_GAP_SEGMENTS } =
      await loadSession();
    const dir = "/hls/seek-b";
    expect(claimVariantEncode(dir, 720, 0)).toBe(0);
    const child = makeChild();
    registerHlsProcess(dir, 720, child);

    expect(claimVariantEncode(dir, 720, 31, onDiskThrough(30))).toBeNull();
    expect(claimVariantEncode(dir, 720, 30 + SEEK_RESTART_GAP_SEGMENTS, onDiskThrough(30))).toBeNull();
    expect(child.kill).not.toHaveBeenCalled();
    // One past the gap is a seek.
    expect(claimVariantEncode(dir, 720, 31 + SEEK_RESTART_GAP_SEGMENTS, onDiskThrough(30))).toBe(
      31 + SEEK_RESTART_GAP_SEGMENTS,
    );
  });

  it("restarts at a segment before the running encode's start", async () => {
    const { claimVariantEncode, registerHlsProcess } = await loadSession();
    const dir = "/hls/seek-c";
    expect(claimVariantEncode(dir, 720, 400)).toBe(400);
    registerHlsProcess(dir, 720, makeChild());

    // Scrubbing back to 2:00, which nothing has encoded.
    expect(claimVariantEncode(dir, 720, 120, () => false)).toBe(120);
  });

  it("restarts a dead encode where the player now is, not at 0", async () => {
    const { claimVariantEncode, registerHlsProcess } = await loadSession();
    const dir = "/hls/seek-d";
    expect(claimVariantEncode(dir, 720, 0)).toBe(0);
    const child = makeChild();
    registerHlsProcess(dir, 720, child);
    child.emit("exit");

    expect(claimVariantEncode(dir, 720, 300, onDiskThrough(50))).toBe(300);
  });

  it("keeps a variant alive while a request waits on it, then lets it be reaped", async () => {
    jest.useFakeTimers();
    const { claimVariantEncode, registerHlsProcess, touchVariant, keepVariantAlive } =
      await loadSession(1_000);
    const dir = "/hls/seek-e";
    expect(claimVariantEncode(dir, 720, 0)).toBe(0);
    const child = makeChild();
    registerHlsProcess(dir, 720, child);
    touchVariant(dir, 720);

    const stop = keepVariantAlive(dir, 720);
    jest.advanceTimersByTime(30_000); // a long wait, many reaper windows
    expect(child.kill).not.toHaveBeenCalled();

    stop();
    jest.advanceTimersByTime(1_500);
    expect(child.kill).toHaveBeenCalled();
  });
});

describe("playback lifecycle hooks", () => {
  it("brackets a session from first touch to tree reap, once per session", async () => {
    jest.useFakeTimers();
    process.env.PHOTRIX_HLS_IDLE_MS = "100";
    const { touchHlsSession, touchVariant, setPlaybackLifecycleHooks } =
      await loadSession(50);
    const onSessionEnd = jest.fn();
    const refresh = jest.fn();
    const onSessionStart = jest.fn(() => ({ release: onSessionEnd, refresh }));
    setPlaybackLifecycleHooks({ onSessionStart });
    const dir = "/hls/f";

    // Repeated touches during one playback session start exactly one bracket —
    // this is what keeps the orchestrator's user-active window (and therefore
    // the GPU reclaim) held across the player's quiet buffering gaps.
    touchHlsSession(dir);
    touchVariant(dir, 360);
    touchHlsSession(dir);
    expect(onSessionStart).toHaveBeenCalledTimes(1);
    expect(onSessionEnd).not.toHaveBeenCalled();
    // Each touch of a live session keeps its lease from aging out mid-playback.
    expect(refresh).toHaveBeenCalledTimes(1);

    // Only once the whole tree goes idle and is reaped does the bracket close.
    jest.advanceTimersByTime(150);
    await jest.runAllTimersAsync();
    expect(onSessionEnd).toHaveBeenCalledTimes(1);

    // A fresh playback after the reap opens a new bracket.
    touchHlsSession(dir);
    expect(onSessionStart).toHaveBeenCalledTimes(2);
    delete process.env.PHOTRIX_HLS_IDLE_MS;
  });
});
