import { describe, expect, it } from "@jest/globals";
import { storyRoute } from "./storyRoute.ts";
import type { StoryItem } from "./storyTypes.ts";

const fix = (lat: number | null, lon: number | null): StoryItem => ({
  path: "/x.jpg",
  time: 0,
  lat,
  lon,
  place: null,
  isVideo: false,
  rating: null,
  quality: null,
  width: null,
  height: null,
  burstMember: false,
});

describe("storyRoute", () => {
  it("collapses nearby fixes into stops and sums the hops between them", () => {
    const { route, distanceKm } = storyRoute([
      fix(41.8902, 12.4922), // Colosseum
      fix(41.8925, 12.4853), // Roman Forum, 0.6 km on: the same stop
      fix(null, null),
      fix(43.7731, 11.256), // Florence, ~230 km
      fix(41.9009, 12.4833), // back to Rome
    ]);
    expect(route).toHaveLength(3);
    expect(distanceKm).toBeGreaterThan(450);
    expect(distanceKm).toBeLessThan(480);
  });

  it("thins a long route to 80 points, keeping both ends", () => {
    const items = Array.from({ length: 500 }, (_, i) => fix(40 + i * 0.05, -100));
    const { route } = storyRoute(items);
    expect(route).toHaveLength(80);
    expect(route[0].lat).toBe(40);
    expect(route.at(-1)!.lat).toBeCloseTo(40 + 499 * 0.05);
  });

  it("has no distance without GPS", () => {
    expect(storyRoute([fix(null, null)])).toEqual({ route: [], distanceKm: null });
  });
});
