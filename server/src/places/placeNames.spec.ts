import { describe, expect, it } from "@jest/globals";
import { notablePlaceTextFor, placeTextFor } from "./placeNames.ts";

describe("placeTextFor", () => {
  it("names the city, state and country of a US coordinate", () => {
    const text = placeTextFor(37.8199, -122.4783); // Golden Gate Bridge
    expect(text).toContain("California");
    expect(text).toContain("United States");
  });

  it("finds North Carolina and Georgia", () => {
    expect(placeTextFor(35.7796, -78.6382)).toContain("North Carolina");
    expect(placeTextFor(33.749, -84.388)).toContain("Georgia");
  });

  it("names a place outside the US with its country", () => {
    expect(placeTextFor(48.8584, 2.2945)).toContain("France");
  });

  it("works across the antimeridian", () => {
    expect(() => placeTextFor(-17.7, 179.9)).not.toThrow();
  });

  it("returns an empty string in the middle of the ocean and for bad input", () => {
    expect(placeTextFor(0, -140)).toBe("");
    expect(placeTextFor(Number.NaN, 10)).toBe("");
    expect(placeTextFor(95, 10)).toBe("");
  });
});

describe("notablePlaceTextFor", () => {
  it("names the big city a landmark is in, not the nearest town", () => {
    expect(placeTextFor(41.8986, 12.4769)).toBe("Vatican City, Vatican City"); // the Pantheon
    expect(notablePlaceTextFor(41.8986, 12.4769)).toBe("Rome, Italy");
    expect(notablePlaceTextFor(43.7731, 11.256)).toBe("Florence, Italy");
    expect(notablePlaceTextFor(34.0094, -118.4973)).toBe("Santa Monica, California, United States, USA"); // the pier
  });

  it("keeps the state of a US place, and says nothing at sea", () => {
    expect(notablePlaceTextFor(36.1069, -112.1129)).toBe("Grand Canyon, Arizona, United States, USA");
    expect(notablePlaceTextFor(0, -140)).toBe("");
  });
});
