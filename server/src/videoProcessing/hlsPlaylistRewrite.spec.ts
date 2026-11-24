import { describe, expect, it } from "@jest/globals";
import {
  rewriteMasterPlaylist,
  rewriteVariantPlaylist,
  segmentUrlBase,
  variantUrlBase,
} from "./hlsPlaylistRewrite.ts";

const master = [
  "#EXTM3U",
  "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360",
  "360p/playlist.m3u8",
  "#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720",
  "720p/playlist.m3u8",
].join("\n");

describe("hlsPlaylistRewrite", () => {
  it("points each variant at the files API, carrying the token", () => {
    const rewritten = rewriteMasterPlaylist(master, variantUrlBase("/2024/a b.mp4", "t&k"));
    expect(rewritten.split("\n")[2]).toBe(
      "/api/files/%2F2024%2Fa%20b.mp4?representation=hls&token=t%26k&variant=360",
    );
    expect(rewritten.split("\n")[4]).toBe(
      "/api/files/%2F2024%2Fa%20b.mp4?representation=hls&token=t%26k&variant=720",
    );
    expect(rewritten.split("\n")[1]).toBe(master.split("\n")[1]);
  });

  it("points each segment at the files API, without a token when there is none", () => {
    const playlist = "#EXTM3U\n#EXTINF:4.0,\nsegment_000.ts\n#EXTINF:4.0,\nsegment_1000.ts\n";
    const rewritten = rewriteVariantPlaylist(playlist, segmentUrlBase("/a.mp4", "720", null));
    expect(rewritten).toBe(
      "#EXTM3U\n#EXTINF:4.0,\n/api/files/%2Fa.mp4?representation=hls&variant=720&segment=segment_000.ts\n" +
        "#EXTINF:4.0,\n/api/files/%2Fa.mp4?representation=hls&variant=720&segment=segment_1000.ts\n",
    );
  });

  it("leaves lines that only mention a segment alone", () => {
    const playlist = "#EXT-X-MAP:URI=segment_000.ts\nsegment_000.ts.bak\n";
    expect(rewriteVariantPlaylist(playlist, "X")).toBe(playlist);
  });
});
