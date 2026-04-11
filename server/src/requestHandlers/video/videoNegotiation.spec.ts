import { describe, expect, it } from "@jest/globals";
import { negotiateVideoPlayback, type NegotiationDeps } from "./videoNegotiation.ts";

const baseDeps = (
  overrides: Partial<NegotiationDeps> = {},
): NegotiationDeps => ({
  hasCachedHLS: async () => false,
  isCudaAvailable: async () => false,
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

describe("negotiateVideoPlayback", () => {
  it("returns HLS when cached multibitrate HLS exists", async () => {
    const result = await negotiateVideoPlayback(
      { path: "video.mp4", bandwidthMbps: 10, hevcSupported: false },
      baseDeps({ hasCachedHLS: async () => true }),
    );

    expect(result).toEqual({
      mode: "hls",
      url: expect.stringContaining("representation=hls"),
      reason: "Cached HLS available",
    });
  });

  it("returns HLS when CUDA is available even without cached HLS", async () => {
    const result = await negotiateVideoPlayback(
      { path: "video.mp4", bandwidthMbps: 10, hevcSupported: false },
      baseDeps({ isCudaAvailable: async () => true }),
    );

    expect(result).toEqual({
      mode: "hls",
      url: expect.stringContaining("representation=hls"),
      reason: "Hardware-accelerated HLS encoding available",
    });
  });

  it("returns direct when no HLS, no CUDA, but client supports H.264 codec", async () => {
    const result = await negotiateVideoPlayback(
      { path: "video.mp4", bandwidthMbps: 50, hevcSupported: false },
      baseDeps({
        getFileMetadata: async () => ({
          sizeInBytes: 100_000_000,
          duration: 60,
          videoCodec: "h264",
        }),
      }),
    );

    expect(result).toEqual({
      mode: "direct",
      url: expect.stringContaining("/api/files/"),
      reason: expect.stringContaining("Direct playback"),
    });
  });

  it("returns direct for HEVC when client supports HEVC", async () => {
    const result = await negotiateVideoPlayback(
      { path: "video.mp4", bandwidthMbps: 50, hevcSupported: true },
      baseDeps({
        getFileMetadata: async () => ({
          sizeInBytes: 100_000_000,
          duration: 60,
          videoCodec: "hevc",
        }),
      }),
    );

    expect(result).toEqual({
      mode: "direct",
      url: expect.stringContaining("/api/files/"),
      reason: expect.stringContaining("Direct playback"),
    });
  });

  it("returns error for HEVC when client does not support HEVC", async () => {
    const result = await negotiateVideoPlayback(
      { path: "video.mp4", bandwidthMbps: 50, hevcSupported: false },
      baseDeps({
        getFileMetadata: async () => ({
          sizeInBytes: 100_000_000,
          duration: 60,
          videoCodec: "hevc",
        }),
      }),
    );

    expect(result.mode).toBe("error");
    expect(result.reason).toContain("cannot play codec");
  });

  it("returns direct when bandwidth is insufficient but no HLS alternative exists", async () => {
    const result = await negotiateVideoPlayback(
      { path: "video.mp4", bandwidthMbps: 1, hevcSupported: false },
      baseDeps({
        getFileMetadata: async () => ({
          sizeInBytes: 500_000_000,
          duration: 60,
          videoCodec: "h264",
        }),
      }),
    );

    expect(result.mode).toBe("direct");
  });

  it("returns direct when bandwidth is null (unknown) — assumes sufficient", async () => {
    const result = await negotiateVideoPlayback(
      { path: "video.mp4", bandwidthMbps: null, hevcSupported: false },
      baseDeps({
        getFileMetadata: async () => ({
          sizeInBytes: 500_000_000,
          duration: 60,
          videoCodec: "h264",
        }),
      }),
    );

    expect(result.mode).toBe("direct");
  });

  it("returns error for non-video files", async () => {
    const result = await negotiateVideoPlayback(
      { path: "photo.jpg", bandwidthMbps: 10, hevcSupported: false },
      baseDeps({ isVideoFile: () => false }),
    );

    expect(result).toEqual({
      mode: "error",
      reason: "Not a video file",
    });
  });

  it("returns error when file does not exist", async () => {
    const result = await negotiateVideoPlayback(
      { path: "missing.mp4", bandwidthMbps: 10, hevcSupported: false },
      baseDeps({ fileExists: async () => false }),
    );

    expect(result).toEqual({
      mode: "error",
      reason: "File not found",
    });
  });

  it("returns error when video codec is unknown", async () => {
    const result = await negotiateVideoPlayback(
      { path: "video.mp4", bandwidthMbps: 10, hevcSupported: false },
      baseDeps({
        getFileMetadata: async () => ({
          sizeInBytes: 100_000_000,
          duration: 60,
          videoCodec: undefined,
        }),
      }),
    );

    expect(result.mode).toBe("error");
    expect(result.reason).toContain("cannot play codec");
  });

  it("prefers cached HLS over CUDA-generated HLS", async () => {
    const result = await negotiateVideoPlayback(
      { path: "video.mp4", bandwidthMbps: 50, hevcSupported: true },
      baseDeps({
        hasCachedHLS: async () => true,
        isCudaAvailable: async () => true,
      }),
    );

    expect(result.reason).toBe("Cached HLS available");
  });

  it("prefers CUDA HLS over direct playback", async () => {
    const result = await negotiateVideoPlayback(
      { path: "video.mp4", bandwidthMbps: 50, hevcSupported: true },
      baseDeps({
        isCudaAvailable: async () => true,
        getFileMetadata: async () => ({
          sizeInBytes: 100_000_000,
          duration: 60,
          videoCodec: "h264",
        }),
      }),
    );

    expect(result.reason).toBe("Hardware-accelerated HLS encoding available");
  });
});
