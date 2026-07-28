import { afterEach, describe, expect, it, vi } from "vitest";

const fetchWithDiagnosticsMock = vi.fn();
vi.mock("./api/http", () => ({
  fetchWithDiagnostics: (...args: unknown[]) => fetchWithDiagnosticsMock(...args),
}));

import {
  probeVideoPlaybackProfile,
  invalidateVideoPlaybackProfile,
  resetVideoPlaybackProfileForTests,
} from "./videoPlaybackProfile";

// A one-chunk ReadableStream-ish body: yields `bytes` of data once, then done.
const bodyOf = (bytes: number) => ({
  getReader: () => {
    let sent = false;
    return {
      read: async () => {
        if (sent) return { done: true, value: undefined };
        sent = true;
        return { done: false, value: new Uint8Array(bytes) };
      },
    };
  },
});

afterEach(() => {
  resetVideoPlaybackProfileForTests();
  fetchWithDiagnosticsMock.mockReset();
});

describe("probeVideoPlaybackProfile", () => {
  it("measures a positive bandwidth from the probe download", async () => {
    fetchWithDiagnosticsMock.mockResolvedValue({ ok: true, body: bodyOf(5_000_000) });

    const profile = await probeVideoPlaybackProfile();

    expect(profile.bandwidthMbps).not.toBeNull();
    expect(profile.bandwidthMbps!).toBeGreaterThan(0);
    expect(Number.isFinite(profile.bandwidthMbps!)).toBe(true);
  });

  it("reports null bandwidth when the probe request fails", async () => {
    fetchWithDiagnosticsMock.mockRejectedValue(new Error("network down"));

    const profile = await probeVideoPlaybackProfile();

    expect(profile.bandwidthMbps).toBeNull();
  });

  it("reports null bandwidth when the response is not ok", async () => {
    fetchWithDiagnosticsMock.mockResolvedValue({ ok: false, body: null });

    const profile = await probeVideoPlaybackProfile();

    expect(profile.bandwidthMbps).toBeNull();
  });

  it("caches the profile so the probe runs once", async () => {
    fetchWithDiagnosticsMock.mockResolvedValue({ ok: true, body: bodyOf(5_000_000) });

    await probeVideoPlaybackProfile();
    await probeVideoPlaybackProfile();

    expect(fetchWithDiagnosticsMock).toHaveBeenCalledTimes(1);
  });

  it("re-measures after invalidation so a changed/throttled link is re-probed", async () => {
    fetchWithDiagnosticsMock.mockResolvedValue({ ok: true, body: bodyOf(5_000_000) });

    await probeVideoPlaybackProfile();
    invalidateVideoPlaybackProfile();
    await probeVideoPlaybackProfile();

    expect(fetchWithDiagnosticsMock).toHaveBeenCalledTimes(2);
  });
});
