import {
  formatDayRange,
  formatDistance,
  formatFrameTime,
  formatStoryStats,
  usesMiles,
} from "./storyFormat";

describe("formatDayRange", () => {
  it("says a range as briefly as it can", () => {
    expect(formatDayRange("2023-05-06", "2023-05-06")).toBe("May 6, 2023");
    expect(formatDayRange("2023-05-03", "2023-05-06")).toBe("May 3 – 6, 2023");
    expect(formatDayRange("2023-05-30", "2023-06-02")).toBe("May 30 – Jun 2, 2023");
    expect(formatDayRange("2023-12-30", "2024-01-02")).toBe("Dec 30, 2023 – Jan 2, 2024");
  });
});

describe("formatFrameTime", () => {
  it("reads a zone-less wall-clock time as written", () => {
    expect(formatFrameTime("2023-05-04T17:10:44")).toBe("Thu, May 4 · 5:10 PM");
  });
});

describe("distances", () => {
  it("uses miles where the road signs do", () => {
    expect(usesMiles("en-US")).toBe(true);
    expect(usesMiles("en-GB")).toBe(true);
    expect(usesMiles("fr-FR")).toBe(false);
    expect(usesMiles("en")).toBe(false);
    expect(formatDistance(470, "en-US")).toBe("292 mi");
    expect(formatDistance(1470, "de-DE")).toBe("1,470 km");
  });
});

describe("formatStoryStats", () => {
  it("lists days, photos, videos and distance, leaving out what doesn't apply", () => {
    expect(
      formatStoryStats(
        { dayCount: 4, photoCount: 12, videoCount: 1, distanceKm: 470 },
        "fr-FR",
      ),
    ).toBe("4 days · 12 photos · 1 video · 470 km");
    expect(
      formatStoryStats(
        { dayCount: 1, photoCount: 1, videoCount: 0, distanceKm: 3 },
        "en-US",
      ),
    ).toBe("1 photo");
    expect(
      formatStoryStats(
        { dayCount: 1, photoCount: 40, videoCount: 0, distanceKm: null },
        "en-US",
      ),
    ).toBe("40 photos");
  });
});
