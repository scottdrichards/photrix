import { fetchWithDiagnostics } from "./api/http";

const getHEVCMimeTypes = (): readonly string[] => {
  const envValue = import.meta.env.VITE_HEVC_MIME_TYPES;
  if (!envValue) {
    // Fallback to default types if env var not set
    return [
      'video/mp4; codecs="hvc1"',
      'video/mp4; codecs="hev1"',
      'video/mp4; codecs="hvc1.1.6.L123.B0"',
      'video/mp4; codecs="hev1.1.6.L123.B0"',
      'video/quicktime; codecs="hvc1"',
      'video/quicktime; codecs="hev1"',
    ];
  }
  return envValue.split(",").map((t: string) => t.trim());
};

const HEVC_MIME_TYPES = getHEVCMimeTypes();

export type VideoPlaybackProfile = {
  bandwidthMbps: number | null;
  hevcSupported: boolean;
};

// Active-measurement parameters. navigator.connection.downlink is unusable here —
// it's capped at ~10 Mbps, rounded for privacy, and null on Safari/Firefox — so we
// time an actual download instead. The window is bounded in *time* (not bytes) so a
// slow link doesn't stall playback startup: we read as much of the payload as fits
// in the budget and derive Mbps from bytes-over-elapsed. The server caps the probe
// at 20 MB, which is enough to estimate links fast enough to matter for raw playback.
const PROBE_BYTES = 20 * 1024 * 1024;
const PROBE_TIME_BUDGET_MS = 2500;

let cachedPlaybackProfile: VideoPlaybackProfile | null = null;
let pendingPlaybackProfile: Promise<VideoPlaybackProfile> | null = null;

const detectHevcSupport = (): boolean => {
  if (typeof document === "undefined") {
    return false;
  }

  const video = document.createElement("video");
  return HEVC_MIME_TYPES.some((mimeType) => {
    const supportLevel = video.canPlayType(mimeType);
    return supportLevel === "probably" || supportLevel === "maybe";
  });
};

/**
 * Measure real downlink throughput by streaming the network probe for a bounded
 * time window. Returns Mbps, or null if it couldn't be measured (fetch failed, no
 * streaming body, or nothing arrived). Aborting when the budget elapses is the
 * normal path on a link that can't drain the whole payload in time.
 */
const measureBandwidthMbps = async (): Promise<number | null> => {
  if (typeof fetch === "undefined") {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIME_BUDGET_MS);
  const start = performance.now();
  let received = 0;
  try {
    const response = await fetchWithDiagnostics(
      `/api/network-probe?bytes=${PROBE_BYTES}`,
      "measure playback bandwidth",
      { signal: controller.signal },
    );
    if (!response.ok || !response.body) {
      return null;
    }
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value?.byteLength ?? 0;
    }
  } catch (error) {
    // The time-budget abort is expected on a link that can't finish the payload in
    // time — we still measured the bytes that arrived. Anything else is a real
    // failure and yields an unknown (null) estimate.
    if ((error as Error).name !== "AbortError") {
      return null;
    }
  } finally {
    clearTimeout(timer);
  }

  const elapsedSeconds = (performance.now() - start) / 1000;
  if (received === 0 || elapsedSeconds <= 0) {
    return null;
  }
  return (received * 8) / elapsedSeconds / 1_000_000;
};

const buildPlaybackProfile = async (): Promise<VideoPlaybackProfile> => {
  const [hevcSupported, bandwidthMbps] = await Promise.all([
    Promise.resolve(detectHevcSupport()),
    measureBandwidthMbps(),
  ]);

  return { bandwidthMbps, hevcSupported };
};

export const probeVideoPlaybackProfile = (): Promise<VideoPlaybackProfile> => {
  if (cachedPlaybackProfile) {
    return Promise.resolve(cachedPlaybackProfile);
  }

  if (pendingPlaybackProfile) {
    return pendingPlaybackProfile;
  }

  pendingPlaybackProfile = buildPlaybackProfile().then((profile) => {
    cachedPlaybackProfile = profile;
    pendingPlaybackProfile = null;
    return profile;
  });

  return pendingPlaybackProfile;
};

/**
 * Discard the cached bandwidth measurement so the next probe re-measures. Called
 * when direct playback stalled: the link is slower than the earlier estimate (which
 * may predate a network change or DevTools throttle), so future videos should be
 * negotiated against a fresh number rather than the stale optimistic one.
 */
export const invalidateVideoPlaybackProfile = () => {
  cachedPlaybackProfile = null;
  pendingPlaybackProfile = null;
};

export const resetVideoPlaybackProfileForTests = () => {
  cachedPlaybackProfile = null;
  pendingPlaybackProfile = null;
};
