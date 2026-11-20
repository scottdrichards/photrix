import { describe, expect, it } from "@jest/globals";
import { frameCount, pickHighlights, type HighlightCandidate } from "./pickHighlights.ts";

const unit = (...values: number[]) => {
  const norm = Math.hypot(...values);
  return Float32Array.from(values, (v) => v / norm);
};

const candidate = (
  path: string,
  minute: number,
  extra: Partial<HighlightCandidate["item"]> = {},
  embedding: Float32Array | null = null,
): HighlightCandidate => ({
  item: {
    path,
    time: minute * 60_000,
    lat: null,
    lon: null,
    place: null,
    isVideo: false,
    rating: null,
    quality: null,
    width: 4000,
    height: 3000,
    burstMember: false,
    ...extra,
  },
  faces: [],
  embedding,
});

const paths = (picks: HighlightCandidate[]) => picks.map(({ item }) => item.path);

describe("pickHighlights", () => {
  it("prefers starred photos and returns them in time order", () => {
    const candidates = [
      candidate("a", 0),
      candidate("b", 600, { rating: 5 }),
      candidate("c", 1200),
      candidate("d", 1800, { rating: 4 }),
    ];
    expect(paths(pickHighlights(candidates, 2))).toEqual(["b", "d"]);
  });

  it("skips a near-duplicate of a photo it already picked", () => {
    const sunset = unit(1, 0.02, 0);
    const candidates = [
      candidate("sunset-1", 0, { rating: 5 }, sunset),
      candidate("sunset-2", 600, { rating: 5 }, unit(1, 0.03, 0)),
      candidate("beach", 1200, { rating: 3 }, unit(0, 1, 0)),
    ];
    expect(paths(pickHighlights(candidates, 2))).toEqual(["sunset-1", "beach"]);
  });

  it("spreads equal photos across the story instead of bunching them", () => {
    // Ten photos in the first hour, two on later days.
    const morning = Array.from({ length: 10 }, (_, i) => candidate(`m${i}`, i));
    const later = [candidate("day2", 24 * 60), candidate("day3", 48 * 60)];
    const picks = paths(pickHighlights([...morning, ...later], 3));
    expect(picks.filter((path) => path.startsWith("m"))).toHaveLength(1);
    expect(picks).toEqual(expect.arrayContaining(["day2", "day3"]));
  });

  it("returns every candidate when there are no more than asked for", () => {
    expect(paths(pickHighlights([candidate("b", 2), candidate("a", 1)], 5))).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("frameCount", () => {
  it("grows with the square root of the story, within 6 to 40 frames", () => {
    expect(frameCount(3)).toBe(3);
    expect(frameCount(12)).toBe(12);
    expect(frameCount(100)).toBe(31);
    expect(frameCount(5000)).toBe(40);
  });
});
