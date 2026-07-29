import { describe, expect, it } from "@jest/globals";
import {
  negotiateVideoPlayback,
  bandwidthCoversRawFile,
  REASON_DIRECT,
  REASON_CACHED_HLS,
  REASON_GPU_HLS,
  REASON_NO_PATH,
  REASON_PREVIEW_CACHED,
  REASON_PREVIEW_DIRECT,
  REASON_PREVIEW_TRANSCODE,
  REASON_PREVIEW_UNAVAILABLE,
  PREVIEW_MAX_SECONDS,
  type NegotiationDeps,
} from "./videoNegotiation.ts";

// Default file: 100 MB over 60 s ≈ 13.3 Mbps average bitrate, so the 1.5× raw
// threshold is 20 Mbps. Bandwidth of 50 clears it; 10 does not.
const baseDeps = (overrides: Partial<NegotiationDeps> = {}): NegotiationDeps => ({
  hasCachedHLS: async () => false,
  getCachedPreviewSeconds: async () => 0,
  isGpuAvailable: async () => false,
  getFileMetadata: async () => ({
    sizeInBytes: 100_000_000,
    duration: 60,
    videoCodec: "h264",
  }),
  isVideoFile: () => true,
  fileExists: async () => true,
  resolveFilePath: (p) => `/storage/${p}`,
  ...overrides,
});

const FAST = 50;
const SLOW = 10;

describe("bandwidthCoversRawFile", () => {
  const meta = { sizeInBytes: 100_000_000, duration: 60 }; // ≈13.3 Mbps → 20 Mbps threshold

  it("is true when measured bandwidth clears the raw bitrate × safety factor", () => {
    expect(bandwidthCoversRawFile(20, meta)).toBe(true);
    expect(bandwidthCoversRawFile(50, meta)).toBe(true);
  });

  it("is false when bandwidth only matches the average bitrate (no headroom)", () => {
    expect(bandwidthCoversRawFile(14, meta)).toBe(false);
  });

  it("is false for unknown bandwidth or missing size/duration", () => {
    expect(bandwidthCoversRawFile(null, meta)).toBe(false);
    expect(bandwidthCoversRawFile(1000, undefined)).toBe(false);
    expect(bandwidthCoversRawFile(1000, { sizeInBytes: 100_000_000, duration: 0 })).toBe(
      false,
    );
  });
});

describe("negotiateVideoPlayback", () => {
  it("returns direct when the link covers the raw file and the codec is playable", async () => {
    const result = await negotiateVideoPlayback(
      { path: "video.mp4", bandwidthMbps: FAST, hevcSupported: false },
      baseDeps(),
    );

    expect(result).toEqual({
      mode: "direct",
      url: expect.stringContaining("/api/files/"),
      reason: REASON_DIRECT,
    });
    expect(result.mode === "direct" && result.url).not.toContain("representation=hls");
  });

  it("skips direct when forceTranscode is set, even on a fast link (stall fallback)", async () => {
    const result = await negotiateVideoPlayback(
      {
        path: "video.mp4",
        bandwidthMbps: FAST,
        hevcSupported: false,
        forceTranscode: true,
      },
      baseDeps({ isGpuAvailable: async () => true }),
    );

    expect(result).toEqual({
      mode: "hls",
      url: expect.stringContaining("representation=hls"),
      reason: REASON_GPU_HLS,
    });
  });

  it("returns direct for HEVC when the client supports HEVC and the link is fast", async () => {
    const result = await negotiateVideoPlayback(
      { path: "video.mp4", bandwidthMbps: FAST, hevcSupported: true },
      baseDeps({
        getFileMetadata: async () => ({
          sizeInBytes: 100_000_000,
          duration: 60,
          videoCodec: "hevc",
        }),
      }),
    );

    expect(result.mode).toBe("direct");
  });

  it("prefers direct over the GPU — a fast link leaves the shared card untouched", async () => {
    const result = await negotiateVideoPlayback(
      { path: "video.mp4", bandwidthMbps: FAST, hevcSupported: false },
      baseDeps({ isGpuAvailable: async () => true }),
    );

    expect(result.mode).toBe("direct");
  });

  it("prefers direct over cached HLS when the link is fast", async () => {
    const result = await negotiateVideoPlayback(
      { path: "video.mp4", bandwidthMbps: FAST, hevcSupported: false },
      baseDeps({ hasCachedHLS: async () => true }),
    );

    expect(result.mode).toBe("direct");
  });

  it("does NOT go direct when the codec is unplayable, even on a fast link", async () => {
    const result = await negotiateVideoPlayback(
      { path: "video.mp4", bandwidthMbps: FAST, hevcSupported: false },
      baseDeps({
        isGpuAvailable: async () => true,
        getFileMetadata: async () => ({
          sizeInBytes: 100_000_000,
          duration: 60,
          videoCodec: "hevc", // client does not support HEVC → must transcode
        }),
      }),
    );

    expect(result).toEqual({
      mode: "hls",
      url: expect.stringContaining("representation=hls"),
      reason: REASON_GPU_HLS,
    });
  });

  it("uses cached HLS when the link is too slow for raw", async () => {
    const result = await negotiateVideoPlayback(
      { path: "video.mp4", bandwidthMbps: SLOW, hevcSupported: false },
      baseDeps({ hasCachedHLS: async () => true }),
    );

    expect(result).toEqual({
      mode: "hls",
      url: expect.stringContaining("representation=hls"),
      reason: REASON_CACHED_HLS,
    });
  });

  it("prefers cached HLS over an on-the-fly GPU encode on a slow link", async () => {
    const result = await negotiateVideoPlayback(
      { path: "video.mp4", bandwidthMbps: SLOW, hevcSupported: false },
      baseDeps({ hasCachedHLS: async () => true, isGpuAvailable: async () => true }),
    );

    expect(result.reason).toBe(REASON_CACHED_HLS);
  });

  it("uses on-the-fly GPU HLS on a slow link when nothing is cached", async () => {
    const result = await negotiateVideoPlayback(
      { path: "video.mp4", bandwidthMbps: SLOW, hevcSupported: false },
      baseDeps({ isGpuAvailable: async () => true }),
    );

    expect(result.reason).toBe(REASON_GPU_HLS);
  });

  it("errors on a slow link with no cache and no GPU — never serves raw", async () => {
    const result = await negotiateVideoPlayback(
      { path: "video.mp4", bandwidthMbps: SLOW, hevcSupported: false },
      baseDeps(),
    );

    expect(result).toEqual({ mode: "error", reason: REASON_NO_PATH });
  });

  it("errors when bandwidth is unknown and there is no cache or GPU", async () => {
    const result = await negotiateVideoPlayback(
      { path: "video.mp4", bandwidthMbps: null, hevcSupported: false },
      baseDeps(),
    );

    expect(result.mode).toBe("error");
  });

  it("does not go direct without known size/duration, transcoding instead", async () => {
    const result = await negotiateVideoPlayback(
      { path: "video.mp4", bandwidthMbps: 1000, hevcSupported: false },
      baseDeps({
        isGpuAvailable: async () => true,
        getFileMetadata: async () => ({ videoCodec: "h264" }),
      }),
    );

    expect(result.reason).toBe(REASON_GPU_HLS);
  });

  it("returns error for non-video files", async () => {
    const result = await negotiateVideoPlayback(
      { path: "photo.jpg", bandwidthMbps: SLOW, hevcSupported: false },
      baseDeps({ isVideoFile: () => false }),
    );

    expect(result).toEqual({ mode: "error", reason: "Not a video file" });
  });

  describe("preview mode (grid hover)", () => {
    // A small file: 6 MB over 60 s ≈ 0.8 Mbps, comfortably under the 12 Mbps
    // cheap-read ceiling and covered by any of the bandwidths used here.
    const smallFile = {
      getFileMetadata: async () => ({
        sizeInBytes: 6_000_000,
        duration: 60,
        videoCodec: "h264",
      }),
    };

    it("uses cached low-rendition segments and bounds playback to them", async () => {
      const result = await negotiateVideoPlayback(
        { path: "video.mp4", bandwidthMbps: SLOW, hevcSupported: false, preview: true },
        baseDeps({ getCachedPreviewSeconds: async () => 3 }),
      );

      expect(result).toEqual({
        mode: "hls",
        url: expect.stringContaining("variant=360"),
        reason: REASON_PREVIEW_CACHED,
        previewMaxSeconds: 3,
      });
    });

    it("clamps the advertised preview length to the hard cap", async () => {
      const result = await negotiateVideoPlayback(
        { path: "video.mp4", bandwidthMbps: SLOW, hevcSupported: false, preview: true },
        baseDeps({ getCachedPreviewSeconds: async () => 120 }),
      );

      expect(result.mode === "hls" && result.previewMaxSeconds).toBe(PREVIEW_MAX_SECONDS);
    });

    it("prefers cached segments over reading the raw original", async () => {
      const result = await negotiateVideoPlayback(
        { path: "video.mp4", bandwidthMbps: FAST, hevcSupported: false, preview: true },
        baseDeps({ ...smallFile, getCachedPreviewSeconds: async () => 2 }),
      );

      expect(result.reason).toBe(REASON_PREVIEW_CACHED);
    });

    it("reads the raw original for a small, playable file on a fast link", async () => {
      const result = await negotiateVideoPlayback(
        { path: "video.mp4", bandwidthMbps: FAST, hevcSupported: false, preview: true },
        baseDeps(smallFile),
      );

      expect(result).toEqual({
        mode: "direct",
        url: expect.not.stringContaining("representation=hls"),
        reason: REASON_PREVIEW_DIRECT,
        previewMaxSeconds: PREVIEW_MAX_SECONDS,
      });
    });

    it("falls back to a live 360p transcode when nothing is cached and a GPU is available", async () => {
      const result = await negotiateVideoPlayback(
        { path: "video.mp4", bandwidthMbps: SLOW, hevcSupported: false, preview: true },
        baseDeps({ isGpuAvailable: async () => true }),
      );

      expect(result).toEqual({
        mode: "hls",
        url: expect.stringContaining("variant=360"),
        reason: REASON_PREVIEW_TRANSCODE,
      });
      // No cap: a live encode plays for as long as the hover lasts.
      expect(result.mode === "hls" && result.previewMaxSeconds).toBeUndefined();
    });

    it("falls back to a live transcode for a high-bitrate original even when the link could carry it", async () => {
      // 100 MB / 60 s ≈ 13.3 Mbps — over the cheap-read ceiling, so no raw preview,
      // but a GPU is available for a real encode.
      const result = await negotiateVideoPlayback(
        { path: "video.mp4", bandwidthMbps: 1000, hevcSupported: false, preview: true },
        baseDeps({ isGpuAvailable: async () => true }),
      );

      expect(result.reason).toBe(REASON_PREVIEW_TRANSCODE);
    });

    it("falls back to a live transcode for a codec it can't read raw", async () => {
      // The source is HEVC (unplayable without HEVC support), but the HLS encode
      // always outputs h264, so a live transcode still works.
      const result = await negotiateVideoPlayback(
        { path: "video.mp4", bandwidthMbps: FAST, hevcSupported: false, preview: true },
        baseDeps({
          isGpuAvailable: async () => true,
          getFileMetadata: async () => ({
            sizeInBytes: 6_000_000,
            duration: 60,
            videoCodec: "hevc",
          }),
        }),
      );

      expect(result.reason).toBe(REASON_PREVIEW_TRANSCODE);
    });

    it("declines when there's no GPU for a live transcode either", async () => {
      const result = await negotiateVideoPlayback(
        { path: "video.mp4", bandwidthMbps: SLOW, hevcSupported: false, preview: true },
        baseDeps(),
      );

      expect(result).toEqual({ mode: "error", reason: REASON_PREVIEW_UNAVAILABLE });
    });

    it("declines when bandwidth was never measured and there's no GPU", async () => {
      const result = await negotiateVideoPlayback(
        { path: "video.mp4", bandwidthMbps: null, hevcSupported: false, preview: true },
        baseDeps(smallFile),
      );

      expect(result.reason).toBe(REASON_PREVIEW_UNAVAILABLE);
    });
  });

  it("returns error when file does not exist", async () => {
    const result = await negotiateVideoPlayback(
      { path: "missing.mp4", bandwidthMbps: SLOW, hevcSupported: false },
      baseDeps({ fileExists: async () => false }),
    );

    expect(result).toEqual({ mode: "error", reason: "File not found" });
  });
});
