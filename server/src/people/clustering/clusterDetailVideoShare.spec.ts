import { describe, it, expect } from "@jest/globals";
import {
  type ClusterDetailRow,
  videoFaceQuota,
  withVideoFaceShare,
} from "./clusterDetailVideoShare.ts";

const row = (id: number, similarity: number, video = false): ClusterDetailRow => ({
  id,
  folder: "/f/",
  fileName: `${id}`,
  boxX: 0,
  boxY: 0,
  boxWidth: 1,
  boxHeight: 1,
  frameTimeMs: video ? 1_000 : null,
  clusterSimilarity: similarity,
  mimeType: video ? "video/mp4" : "image/jpeg",
  dimensionWidth: null,
  dimensionHeight: null,
  regions: null,
  dateTaken: null,
});

describe("videoFaceQuota", () => {
  it("is the videos' share of the cap", () => {
    // Measured live: 2393 of 19347 faces were video.
    expect(videoFaceQuota(2000, 19347, 2393)).toBe(247);
  });

  it("keeps at least one video face, and none when there are none", () => {
    expect(videoFaceQuota(2000, 100_000, 3)).toBe(1);
    expect(videoFaceQuota(2000, 100_000, 0)).toBe(0);
  });

  it("is every video face under the cap", () => {
    expect(videoFaceQuota(2000, 500, 40)).toBe(40);
  });
});

describe("withVideoFaceShare", () => {
  it("drops the weakest photos for the best videos, best match first", () => {
    const rows = [row(1, 0.9), row(2, 0.8), row(3, 0.7, true), row(4, 0.6)];
    const videos = [row(3, 0.7, true), row(5, 0.65, true)];
    expect(withVideoFaceShare(rows, videos, 4).map((r) => r.id)).toEqual([1, 2, 3, 5]);
  });

  it("never returns more than the cap", () => {
    const rows = [row(1, 0.9), row(2, 0.8)];
    const videos = [row(3, 0.5, true), row(4, 0.4, true), row(5, 0.3, true)];
    expect(withVideoFaceShare(rows, videos, 2).map((r) => r.id)).toEqual([3, 4]);
  });
});
