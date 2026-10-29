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
  it("claims on first request, then not while the encode is live", async () => {
    const { claimVariantEncode, registerHlsProcess } = await loadSession();
    const dir = "/hls/a";

    // First request for a variant starts an encode.
    expect(claimVariantEncode(dir, 720)).not.toBeNull();
    registerHlsProcess(dir, 720, makeChild());

    // Subsequent requests while encode is live must NOT restart it — that would
    // double-spawn into the same directory.
    expect(claimVariantEncode(dir, 720)).toBeNull();
    expect(claimVariantEncode(dir, 720)).toBeNull();
  });

  it("starts an independent encode per variant (ABR variant switch)", async () => {
    const { claimVariantEncode } = await loadSession();
    const dir = "/hls/b";

    expect(claimVariantEncode(dir, 360)).not.toBeNull();
    // Switching up to 720p mid-stream: a new variant with no encode starts one.
    expect(claimVariantEncode(dir, 720)).not.toBeNull();
    // Subsequent 720p requests are covered by the running encode.
    expect(claimVariantEncode(dir, 720)).toBeNull();
  });

  it("claims again once the encode process has exited, then not after restart", async () => {
    const { claimVariantEncode, registerHlsProcess } = await loadSession();
    const dir = "/hls/d";

    expect(claimVariantEncode(dir, 720)).not.toBeNull();
    const child = makeChild();
    registerHlsProcess(dir, 720, child);
    expect(claimVariantEncode(dir, 720)).toBeNull(); // still running

    child.emit("exit"); // encoder finished/crashed → slot is dead
    expect(claimVariantEncode(dir, 720)).not.toBeNull(); // needs restart
    registerHlsProcess(dir, 720, makeChild());
    expect(claimVariantEncode(dir, 720)).toBeNull(); // live again
  });

  it("reaps an idle variant's encode and restarts on re-selection", async () => {
    jest.useFakeTimers();
    const { claimVariantEncode, registerHlsProcess, touchVariant } =
      await loadSession(50);
    const dir = "/hls/e";

    expect(claimVariantEncode(dir, 360)).not.toBeNull();
    const child = makeChild();
    registerHlsProcess(dir, 360, child);
    touchVariant(dir, 360);

    // No fetches for this variant past the idle window (ABR switched away) → killed.
    jest.advanceTimersByTime(60);
    expect(child.kill).toHaveBeenCalled();

    // Re-selecting it later restarts the encode.
    expect(claimVariantEncode(dir, 360)).not.toBeNull();
  });
});

// What a player does mid-stream, and what each costs the encoder. A "produced"
// set stands in for the segment files an encode has written so far.
describe("claiming an encode at the player's position", () => {
  const produced = (...indices: number[]) => {
    const set = new Set(indices);
    return (i: number) => set.has(i);
  };
  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => from + i);

  it("starts a variant's first encode at the requested segment, not at 0", async () => {
    const { claimVariantEncode } = await loadSession();
    // An ABR switch to 1080p five minutes in asks for segment 300 first. An
    // encode from 0 would make the player wait for 300 s of video to encode.
    expect(claimVariantEncode("/hls/abr", 1080, 300)).toMatchObject({ startSegment: 300 });
  });

  it("waits for the running encode while the request is within the gap past its head", async () => {
    const { claimVariantEncode, registerHlsProcess, SEEK_RESTART_GAP_SEGMENTS } =
      await loadSession();
    const dir = "/hls/fill";
    const claim = claimVariantEncode(dir, 720, 0)!;
    const child = makeChild();
    registerHlsProcess(dir, 720, child, claim.runId);
    const onDiskThrough = (head: number) => (i: number) => i <= head;

    // Buffer fill: the player asks for the segment after the last one written.
    expect(claimVariantEncode(dir, 720, 31, onDiskThrough(30))).toBeNull();
    expect(
      claimVariantEncode(dir, 720, 30 + SEEK_RESTART_GAP_SEGMENTS, onDiskThrough(30)),
    ).toBeNull();
    expect(child.kill).not.toHaveBeenCalled();
    // One past the gap is a seek (feedback #167).
    expect(
      claimVariantEncode(dir, 720, 31 + SEEK_RESTART_GAP_SEGMENTS, onDiskThrough(30)),
    ).toMatchObject({ startSegment: 31 + SEEK_RESTART_GAP_SEGMENTS });
  });

  it("starts an encode at a far seek, then serves the following segments from it", async () => {
    const { claimVariantEncode, registerHlsProcess, SEEK_RESTART_GAP_SEGMENTS } =
      await loadSession();
    const dir = "/hls/seek-follow";
    const fromZero = claimVariantEncode(dir, 720, 0)!;
    registerHlsProcess(dir, 720, makeChild(), fromZero.runId);
    const onDiskThrough = (head: number) => (i: number) => i <= head;

    // Scrubbing to 7:00 while the encode from 0:00 is at 0:30.
    const seek = claimVariantEncode(dir, 720, 420, onDiskThrough(30))!;
    expect(seek.startSegment).toBe(420);
    registerHlsProcess(dir, 720, makeChild(), seek.runId);

    // The next segments come from the new encode, though none is on disk yet.
    expect(claimVariantEncode(dir, 720, 421, onDiskThrough(30))).toBeNull();
    expect(
      claimVariantEncode(dir, 720, 419 + SEEK_RESTART_GAP_SEGMENTS, onDiskThrough(30)),
    ).toBeNull();
  });

  it("restarts an ended encode where the player now is, not at 0", async () => {
    const { claimVariantEncode, registerHlsProcess } = await loadSession();
    const dir = "/hls/seek-dead";
    const claim = claimVariantEncode(dir, 720, 0)!;
    const child = makeChild();
    registerHlsProcess(dir, 720, child, claim.runId);
    child.emit("exit");

    expect(claimVariantEncode(dir, 720, 300, (i) => i <= 50)).toMatchObject({
      startSegment: 300,
    });
  });

  it("starts at a forward seek target instead of waiting for the encode to crawl there", async () => {
    jest.useFakeTimers();
    const { claimVariantEncode, registerHlsProcess } = await loadSession(50);
    const dir = "/hls/seek-ahead";
    const first = claimVariantEncode(dir, 720, 0)!;
    const firstChild = makeChild();
    registerHlsProcess(dir, 720, firstChild, first.runId);

    const claim = claimVariantEncode(dir, 720, 300, produced(...range(0, 10)));
    expect(claim).toMatchObject({ startSegment: 300 });
    expect(claim?.runId).not.toBe(first.runId);

    // The encode left behind is not needed by anyone now; it idles out.
    jest.advanceTimersByTime(60);
    expect(firstChild.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("starts at a backward seek target behind where the encode began", async () => {
    const { claimVariantEncode, registerHlsProcess } = await loadSession();
    const dir = "/hls/seek-back";
    const first = claimVariantEncode(dir, 720, 120)!;
    registerHlsProcess(dir, 720, makeChild(), first.runId);
    expect(claimVariantEncode(dir, 720, 20, produced(...range(120, 130)))).toMatchObject({
      startSegment: 20,
    });
  });

  it("gives two viewers far apart in one video an encode each, instead of one they fight over", async () => {
    const { claimVariantEncode, registerHlsProcess } = await loadSession();
    const dir = "/hls/two-viewers";
    const a = claimVariantEncode(dir, 1080, 0)!;
    const aChild = makeChild();
    registerHlsProcess(dir, 1080, aChild, a.runId);

    // Viewer B jumps to 3:20 while A watches the start.
    const b = claimVariantEncode(dir, 1080, 200, produced(...range(0, 20)))!;
    expect(b.startSegment).toBe(200);
    registerHlsProcess(dir, 1080, makeChild(), b.runId);
    expect(aChild.kill).not.toHaveBeenCalled();

    // Each keeps being served by its own encode: no restarts either way.
    const nowOnDisk = produced(...range(0, 21), 200);
    expect(claimVariantEncode(dir, 1080, 21, nowOnDisk)).toBeNull();
    expect(claimVariantEncode(dir, 1080, 201, nowOnDisk)).toBeNull();
    expect(claimVariantEncode(dir, 1080, 22, nowOnDisk)).toBeNull();
  });

  it("drops the least recently used encode past the per-variant cap", async () => {
    jest.useFakeTimers();
    const { claimVariantEncode, registerHlsProcess, touchVariant } = await loadSession(60_000);
    const dir = "/hls/cap";
    const children = [0, 100, 200].map((start) => {
      const claim = claimVariantEncode(dir, 720, start, produced())!;
      const child = makeChild();
      registerHlsProcess(dir, 720, child, claim.runId);
      jest.advanceTimersByTime(1_000);
      return child;
    });
    touchVariant(dir, 720, 0); // the first is still being watched

    claimVariantEncode(dir, 720, 300, produced());
    expect(children[1].kill).toHaveBeenCalledWith("SIGKILL");
    expect(children[0].kill).not.toHaveBeenCalledWith("SIGKILL");
    expect(children[2].kill).not.toHaveBeenCalledWith("SIGKILL");
  });

  it("without a segment index, any live encode counts (EVENT playlist reloads)", async () => {
    const { claimVariantEncode, registerHlsProcess } = await loadSession();
    const dir = "/hls/event";
    const claim = claimVariantEncode(dir, 720, 300)!;
    registerHlsProcess(dir, 720, makeChild(), claim.runId);
    // Reloading the growing playlist must not drag the encode back to 0.
    expect(claimVariantEncode(dir, 720)).toBeNull();
  });

  it("kills a spawn for an encode that was dropped before it spawned", async () => {
    jest.useFakeTimers();
    const { claimVariantEncode, registerHlsProcess } = await loadSession(50);
    const dir = "/hls/race";
    const stale = claimVariantEncode(dir, 720, 0)!;
    // Queued behind a busy encoder long enough that nobody wants it any more.
    jest.advanceTimersByTime(60);

    const late = makeChild();
    registerHlsProcess(dir, 720, late, stale.runId);
    expect(late.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("lets a retry on a lower encoder tier take over its encode", async () => {
    const { claimVariantEncode, registerHlsProcess } = await loadSession();
    const dir = "/hls/retry";
    const claim = claimVariantEncode(dir, 720, 0)!;
    const gpu = makeChild();
    registerHlsProcess(dir, 720, gpu, claim.runId);

    // The hardware encode fails; encodeVariant respawns on the next tier with
    // the same claim. That must not be mistaken for an orphan.
    gpu.emit("exit");
    const retry = makeChild();
    registerHlsProcess(dir, 720, retry, claim.runId);
    expect(retry.kill).not.toHaveBeenCalled();
    expect(claimVariantEncode(dir, 720, 1, produced(0))).toBeNull();
  });
});

describe("the variant idle reaper and waiting requests", () => {
  it("does not kill an encode while a request is waiting for its next segment", async () => {
    jest.useFakeTimers();
    const { keepVariantAlive, claimVariantEncode, registerHlsProcess } =
      await loadSession(50);
    const dir = "/hls/wait";
    claimVariantEncode(dir, 720, 0);
    const child = makeChild();
    registerHlsProcess(dir, 720, child);

    // A slow encode: the request waits far longer than the idle window.
    const endWait = keepVariantAlive(dir, 720);
    jest.advanceTimersByTime(500);
    expect(child.kill).not.toHaveBeenCalled();

    // Once nobody is waiting and nothing else arrives, it is reaped as before.
    endWait();
    jest.advanceTimersByTime(60);
    expect(child.kill).toHaveBeenCalled();
  });

  it("counts the end of a wait as activity, so the next request isn't racing the reaper", async () => {
    jest.useFakeTimers();
    const { keepVariantAlive, claimVariantEncode, registerHlsProcess } =
      await loadSession(50);
    const dir = "/hls/wait-end";
    claimVariantEncode(dir, 720, 0);
    const child = makeChild();
    registerHlsProcess(dir, 720, child);

    const endWait = keepVariantAlive(dir, 720);
    jest.advanceTimersByTime(45);
    endWait();
    jest.advanceTimersByTime(45); // 90 ms after the claim, 45 after the wait ended
    expect(child.kill).not.toHaveBeenCalled();
  });
});

describe("pacing an encode to the player", () => {
  it("freezes an encode far ahead of the player and thaws it as the player catches up", async () => {
    jest.useFakeTimers();
    const { claimVariantEncode, registerHlsProcess, touchVariant } = await loadSession(60_000);
    const dir = "/hls/pace";
    let written = 40; // segments 0..40 on disk
    const isProduced = (i: number) => i <= written;
    claimVariantEncode(dir, 720, 0, isProduced);
    const child = makeChild();
    registerHlsProcess(dir, 720, child);

    // The player has asked for segment 0 only; the encode is 40 ahead.
    jest.advanceTimersByTime(600);
    expect(child.kill).toHaveBeenCalledWith("SIGSTOP");

    // Still a full buffer ahead: stays frozen, so the GPU goes to someone else.
    touchVariant(dir, 720, 15);
    expect(child.kill).not.toHaveBeenCalledWith("SIGCONT");

    // Close enough that it must start producing again.
    touchVariant(dir, 720, 25);
    expect(child.kill).toHaveBeenCalledWith("SIGCONT");

    // And it is frozen again once it has run far enough ahead.
    child.kill.mockClear();
    written = 60;
    jest.advanceTimersByTime(600);
    expect(child.kill).toHaveBeenCalledWith("SIGSTOP");
  });

  it("thaws a frozen encode when a request claims the segment it is waiting for", async () => {
    jest.useFakeTimers();
    const { claimVariantEncode, registerHlsProcess } = await loadSession(60_000);
    const dir = "/hls/pace-claim";
    const isProduced = (i: number) => i <= 40;
    claimVariantEncode(dir, 720, 0, isProduced);
    const child = makeChild();
    registerHlsProcess(dir, 720, child);
    jest.advanceTimersByTime(600);
    expect(child.kill).toHaveBeenCalledWith("SIGSTOP");

    // The player reaches the encode head and long-polls the next segment. The
    // running encode covers it, so no restart, but it must be running again.
    expect(claimVariantEncode(dir, 720, 41, isProduced)).toBeNull();
    expect(child.kill).toHaveBeenCalledWith("SIGCONT");
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
