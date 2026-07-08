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
  it("returns true on first claim, then false while encode is live", async () => {
    const { claimVariantEncode, registerHlsProcess } = await loadSession();
    const dir = "/hls/a";

    // First request for a variant starts an encode.
    expect(claimVariantEncode(dir, 720)).toBe(true);
    registerHlsProcess(dir, 720, makeChild());

    // Subsequent requests while encode is live must NOT restart it — that would
    // double-spawn into the same directory.
    expect(claimVariantEncode(dir, 720)).toBe(false);
    expect(claimVariantEncode(dir, 720)).toBe(false);
  });

  it("starts an independent encode per variant (ABR variant switch)", async () => {
    const { claimVariantEncode } = await loadSession();
    const dir = "/hls/b";

    expect(claimVariantEncode(dir, 360)).toBe(true);
    // Switching up to 720p mid-stream: a new variant with no encode starts one.
    expect(claimVariantEncode(dir, 720)).toBe(true);
    // Subsequent 720p requests are covered by the running encode.
    expect(claimVariantEncode(dir, 720)).toBe(false);
  });

  it("returns true once the encode process has exited, then false again after restart", async () => {
    const { claimVariantEncode, registerHlsProcess } = await loadSession();
    const dir = "/hls/d";

    expect(claimVariantEncode(dir, 720)).toBe(true);
    const child = makeChild();
    registerHlsProcess(dir, 720, child);
    expect(claimVariantEncode(dir, 720)).toBe(false); // still running

    child.emit("exit"); // encoder finished/crashed → slot is dead
    expect(claimVariantEncode(dir, 720)).toBe(true); // needs restart
    registerHlsProcess(dir, 720, makeChild());
    expect(claimVariantEncode(dir, 720)).toBe(false); // live again
  });

  it("reaps an idle variant's encode and restarts on re-selection", async () => {
    jest.useFakeTimers();
    const { claimVariantEncode, registerHlsProcess, touchVariant } = await loadSession(50);
    const dir = "/hls/e";

    expect(claimVariantEncode(dir, 360)).toBe(true);
    const child = makeChild();
    registerHlsProcess(dir, 360, child);
    touchVariant(dir, 360);

    // No fetches for this variant past the idle window (ABR switched away) → killed.
    jest.advanceTimersByTime(60);
    expect(child.kill).toHaveBeenCalled();

    // Re-selecting it later restarts the encode.
    expect(claimVariantEncode(dir, 360)).toBe(true);
  });
});
