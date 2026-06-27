import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

// A minimal fake ffmpeg process: an EventEmitter with a spy-able kill().
const makeChild = () => {
  const child = new EventEmitter() as EventEmitter & ChildProcess & { kill: jest.Mock };
  child.kill = jest.fn(() => true) as unknown as ChildProcess["kill"] & jest.Mock;
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
  it("claims once, then treats segments at/after the start point as already covered", async () => {
    const { claimVariantEncode } = await loadSession();
    const dir = "/hls/a";

    // First request for a variant claims an encode starting at that segment.
    expect(claimVariantEncode(dir, 720, 0)).toBe(0);
    // Buffer-ahead requests are covered by the pending encode (child not spawned yet),
    // so they must NOT claim again — that would double-spawn into the same directory.
    expect(claimVariantEncode(dir, 720, 1)).toBeNull();
    expect(claimVariantEncode(dir, 720, 50)).toBeNull();
  });

  it("starts an independent encode per variant (ABR up-switch begins at the play position)", async () => {
    const { claimVariantEncode } = await loadSession();
    const dir = "/hls/b";

    expect(claimVariantEncode(dir, 360, 0)).toBe(0);
    // Switching up to 720p mid-stream: a new variant with no encode begins exactly at
    // the requested (current) position, not from 0.
    expect(claimVariantEncode(dir, 720, 120)).toBe(120);
    expect(claimVariantEncode(dir, 720, 121)).toBeNull();
  });

  it("does not mistake startup buffer-fill for a forward seek", async () => {
    const { claimVariantEncode, touchVariant, registerHlsProcess } = await loadSession();
    const dir = "/hls/fill";

    // Sequential buffer-fill ahead of a from-0 encode that hasn't caught up yet.
    let forwardSeek = touchVariant(dir, 720, 0);
    expect(forwardSeek).toBe(false);
    expect(claimVariantEncode(dir, 720, 0, forwardSeek)).toBe(0);
    registerHlsProcess(dir, 720, makeChild());

    // Requesting segments 1..40 in order must never look like a seek, even though the
    // encode is far behind — the high-water mark advances one at a time.
    for (let n = 1; n <= 40; n++) {
      forwardSeek = touchVariant(dir, 720, n);
      expect(forwardSeek).toBe(false);
      expect(claimVariantEncode(dir, 720, n, forwardSeek)).toBeNull();
    }
  });

  it("restarts at the seek target on a large forward jump", async () => {
    const { claimVariantEncode, touchVariant, registerHlsProcess } = await loadSession();
    const dir = "/hls/fwd";

    touchVariant(dir, 720, 0);
    expect(claimVariantEncode(dir, 720, 0, false)).toBe(0);
    const child = makeChild();
    registerHlsProcess(dir, 720, child);

    // Player buffers a little, then seeks far ahead of everything requested so far.
    touchVariant(dir, 720, 1);
    const forwardSeek = touchVariant(dir, 720, 600);
    expect(forwardSeek).toBe(true);
    // The stale from-0 encode is killed and a new one starts at the seek target.
    expect(claimVariantEncode(dir, 720, 600, forwardSeek)).toBe(600);
    expect(child.kill).toHaveBeenCalled();

    // Sequential playback after the seek does not keep restarting.
    registerHlsProcess(dir, 720, makeChild());
    const next = touchVariant(dir, 720, 601);
    expect(next).toBe(false);
    expect(claimVariantEncode(dir, 720, 601, next)).toBeNull();
  });

  it("restarts (killing the old encode) on a backward seek", async () => {
    const { claimVariantEncode, registerHlsProcess } = await loadSession();
    const dir = "/hls/c";

    expect(claimVariantEncode(dir, 720, 300)).toBe(300);
    const child = makeChild();
    registerHlsProcess(dir, 720, child);

    // Seeking back before the encode's start point can never be satisfied by it, so
    // the slot restarts at the earlier segment and the stale encode is killed.
    expect(claimVariantEncode(dir, 720, 100)).toBe(100);
    expect(child.kill).toHaveBeenCalled();
  });

  it("restarts once the encode process has exited", async () => {
    const { claimVariantEncode, registerHlsProcess } = await loadSession();
    const dir = "/hls/d";

    expect(claimVariantEncode(dir, 720, 0)).toBe(0);
    const child = makeChild();
    registerHlsProcess(dir, 720, child);
    expect(claimVariantEncode(dir, 720, 10)).toBeNull(); // still running, covered

    child.emit("exit"); // encoder finished/crashed → slot is dead
    // A request for a segment the dead encode never produced restarts it.
    expect(claimVariantEncode(dir, 720, 10)).toBe(10);
  });

  it("reaps an idle variant's encode and restarts it on re-selection", async () => {
    jest.useFakeTimers();
    const { claimVariantEncode, registerHlsProcess, touchVariant } = await loadSession(50);
    const dir = "/hls/e";

    expect(claimVariantEncode(dir, 360, 0)).toBe(0);
    const child = makeChild();
    registerHlsProcess(dir, 360, child);
    touchVariant(dir, 360);

    // No fetches for this variant past the idle window (ABR switched away) → killed.
    jest.advanceTimersByTime(60);
    expect(child.kill).toHaveBeenCalled();

    // Re-selecting it later restarts the encode at the newly requested position.
    expect(claimVariantEncode(dir, 360, 200)).toBe(200);
  });
});
