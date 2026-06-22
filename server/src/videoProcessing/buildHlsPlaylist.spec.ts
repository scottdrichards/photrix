import { describe, expect, it } from "@jest/globals";
import { buildVodVariantPlaylist, HLS_SEGMENT_SECONDS } from "./buildHlsPlaylist.ts";

const segmentLines = (playlist: string): string[] =>
  playlist.split("\n").filter((line) => line.includes("segment_"));

const extinfDurations = (playlist: string): number[] =>
  playlist
    .split("\n")
    .filter((line) => line.startsWith("#EXTINF:"))
    .map((line) => parseFloat(line.slice("#EXTINF:".length)));

describe("buildVodVariantPlaylist", () => {
  it("produces a terminated VOD playlist with the standard headers", () => {
    const playlist = buildVodVariantPlaylist({
      durationSeconds: 4,
      segmentBaseUrl: "base/",
    });

    expect(playlist).toContain("#EXTM3U");
    expect(playlist).toContain("#EXT-X-PLAYLIST-TYPE:VOD");
    expect(playlist).toContain(`#EXT-X-TARGETDURATION:${HLS_SEGMENT_SECONDS}`);
    expect(playlist).toContain("#EXT-X-MEDIA-SEQUENCE:0");
    expect(playlist.trimEnd().endsWith("#EXT-X-ENDLIST")).toBe(true);
  });

  it("lists ceil(duration / segmentSeconds) segments with the remainder last", () => {
    const playlist = buildVodVariantPlaylist({
      durationSeconds: 5,
      segmentBaseUrl: "base/",
      segmentSeconds: 2,
    });

    // 5s at 2s segments → 3 segments: 2 + 2 + 1
    expect(segmentLines(playlist)).toEqual([
      "base/segment_000.ts",
      "base/segment_001.ts",
      "base/segment_002.ts",
    ]);
    expect(extinfDurations(playlist)).toEqual([2, 2, 1]);
  });

  it("makes the EXTINF durations sum to the exact total duration", () => {
    const durationSeconds = 23.7;
    const playlist = buildVodVariantPlaylist({ durationSeconds, segmentBaseUrl: "" });
    const total = extinfDurations(playlist).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(durationSeconds, 5);
  });

  it("emits a single full-length segment for durations under one segment", () => {
    const playlist = buildVodVariantPlaylist({
      durationSeconds: 0.5,
      segmentBaseUrl: "base/",
    });
    expect(segmentLines(playlist)).toEqual(["base/segment_000.ts"]);
    expect(extinfDurations(playlist)).toEqual([0.5]);
  });

  it("zero-pads segment names to at least three digits and grows beyond 999", () => {
    const playlist = buildVodVariantPlaylist({
      durationSeconds: 2002, // 1001 segments → indices 0..1000
      segmentBaseUrl: "",
    });
    expect(playlist).toContain("segment_000.ts");
    expect(playlist).toContain("segment_999.ts");
    expect(playlist).toContain("segment_1000.ts");
  });
});
