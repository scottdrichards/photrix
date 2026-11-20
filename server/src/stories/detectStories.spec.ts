import { describe, expect, it } from "@jest/globals";
import {
  dayNumber,
  defaultDetectOptions,
  detectStories,
  type DetectOptions,
} from "./detectStories.ts";
import type { StoryItem } from "./storyTypes.ts";

const SEATTLE = { lat: 47.6205, lon: -122.3493 };
const ROME = { lat: 41.8902, lon: 12.4922 };
const PORTLAND = { lat: 45.5152, lon: -122.6784 };
const DENVER = { lat: 39.7392, lon: -104.9903 };

let serial = 0;
/** An item at local wall-clock time (month is 1-based), optionally geotagged. */
const at = (
  y: number,
  m: number,
  d: number,
  h: number,
  where: { lat: number; lon: number } | null,
): StoryItem => ({
  path: `/p/${serial++}.jpg`,
  time: new Date(y, m - 1, d, h).getTime(),
  lat: where?.lat ?? null,
  lon: where?.lon ?? null,
  place: null,
  isVideo: false,
  rating: null,
  quality: null,
  width: 4000,
  height: 3000,
  burstMember: false,
});

const options: DetectOptions = {
  awayKm: 80,
  homeCellDegrees: 0.5,
  minHomeDays: 5,
  maxGapDays: 2,
  maxTripDays: 45,
  minTripPhotos: 4,
  minEventPhotos: 10,
};

/** A home base: one photo a week through `year`. */
const homeYear = (year: number, where = SEATTLE) =>
  Array.from({ length: 50 }, (_, week) => at(year, 1, 1 + week * 7, 12, where));

const span = (stories: ReturnType<typeof detectStories>) =>
  stories.map(({ kind, startDay, endDay, items }) => ({
    kind,
    startDay,
    endDay,
    count: items.length,
  }));

describe("detectStories", () => {
  it("finds a run of days away from home as a trip", () => {
    const trip = [3, 4, 5, 6].flatMap((d) => [
      at(2023, 5, d, 10, ROME),
      at(2023, 5, d, 16, ROME),
    ]);
    expect(span(detectStories([...homeYear(2023), ...trip], options))).toEqual([
      { kind: "trip", startDay: "2023-05-03", endDay: "2023-05-06", count: 8 },
    ]);
  });

  it("keeps GPS-less days inside a trip but trims them off its end", () => {
    const trip = [
      at(2023, 5, 3, 10, ROME),
      at(2023, 5, 3, 11, ROME),
      at(2023, 5, 4, 10, null), // a camera without GPS, mid-trip
      at(2023, 5, 5, 10, ROME),
      at(2023, 5, 5, 11, ROME),
      at(2023, 5, 6, 10, null), // and on the way home
    ];
    expect(span(detectStories([...homeYear(2023), ...trip], options))).toEqual([
      { kind: "trip", startDay: "2023-05-03", endDay: "2023-05-05", count: 5 },
    ]);
  });

  it("ends a trip at a day back home, and at a long gap", () => {
    const first = [
      at(2023, 5, 3, 10, ROME),
      at(2023, 5, 3, 12, ROME),
      at(2023, 5, 4, 10, ROME),
      at(2023, 5, 4, 12, ROME),
    ];
    const backHome = at(2023, 5, 5, 10, SEATTLE);
    const second = [
      at(2023, 5, 6, 10, ROME),
      at(2023, 5, 6, 12, ROME),
      at(2023, 5, 7, 10, ROME),
      at(2023, 5, 7, 12, ROME),
    ];
    const afterGap = [
      at(2023, 5, 11, 10, ROME),
      at(2023, 5, 11, 12, ROME),
      at(2023, 5, 11, 14, ROME),
      at(2023, 5, 11, 16, ROME),
    ];
    expect(
      span(
        detectStories(
          [...homeYear(2023), ...first, backHome, ...second, ...afterGap],
          options,
        ),
      ).map(({ startDay }) => startDay),
    ).toEqual(["2023-05-11", "2023-05-06", "2023-05-03"]);
  });

  it("drops trips with too few photos, and stretches too long to be a trip", () => {
    const short = [at(2023, 5, 3, 10, ROME), at(2023, 5, 3, 11, ROME)];
    const relocation = Array.from({ length: 60 }, (_, d) => at(2023, 8, 1 + d, 12, ROME));
    expect(detectStories([...homeYear(2023), ...short, ...relocation], options)).toEqual(
      [],
    );
  });

  it("calls a one-day trip a day trip and a short trip over a weekend a weekend", () => {
    const dayTrip = [9, 11, 13, 15].map((h) => at(2023, 3, 15, h, PORTLAND)); // a Wednesday
    const weekend = [
      at(2023, 6, 9, 18, DENVER),
      at(2023, 6, 10, 10, DENVER),
      at(2023, 6, 10, 15, DENVER),
      at(2023, 6, 11, 9, DENVER),
    ]; // Fri-Sun
    expect(
      span(detectStories([...homeYear(2023), ...dayTrip, ...weekend], options)).map(
        ({ kind }) => kind,
      ),
    ).toEqual(["weekend", "dayTrip"]);
  });

  it("follows a move: the new town becomes home for the year after", () => {
    const newHome = homeYear(2024, DENVER);
    const visitOldTown = [10, 12, 14, 16].map((h) => at(2024, 7, 20, h, SEATTLE));
    const stories = detectStories(
      [...homeYear(2023), ...newHome, ...visitOldTown],
      options,
    );
    expect(span(stories)).toEqual([
      { kind: "dayTrip", startDay: "2024-07-20", endDay: "2024-07-20", count: 4 },
    ]);
  });

  it("finds a day at home with far more photos than usual as an event, merging adjacent days", () => {
    const party = [
      ...Array.from({ length: 12 }, (_, i) => at(2023, 7, 4, 10 + (i % 10), SEATTLE)),
      ...Array.from({ length: 10 }, (_, i) => at(2023, 7, 5, 9 + i, null)),
    ];
    expect(span(detectStories([...homeYear(2023), ...party], options))).toEqual([
      { kind: "event", startDay: "2023-07-04", endDay: "2023-07-05", count: 22 },
    ]);
  });

  it("finds nothing away without any GPS to place home", () => {
    const items = Array.from({ length: 30 }, (_, d) => at(2023, 1, 1 + d, 12, null));
    expect(detectStories(items, options)).toEqual([]);
  });
});

describe("dayNumber", () => {
  it("counts local calendar days, so late evening and early morning are different days", () => {
    expect(dayNumber(new Date(2023, 4, 3, 23, 59).getTime()) + 1).toBe(
      dayNumber(new Date(2023, 4, 4, 0, 1).getTime()),
    );
  });
});

describe("defaultDetectOptions", () => {
  it("lowers the bar for a small library and raises it for a large one", () => {
    expect(defaultDetectOptions(homeYear(2023)).minTripPhotos).toBe(4);
    const large = Array.from({ length: 100_000 }, (_, i) =>
      at(2023, 1, 1 + (i % 365), 12, null),
    );
    expect(defaultDetectOptions(large).minTripPhotos).toBe(12);
    // ~274 photos a typical day, so an event needs four times that.
    expect(defaultDetectOptions(large).minEventPhotos).toBe(1096);
  });
});
