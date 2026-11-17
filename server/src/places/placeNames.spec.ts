import { describe, expect, it } from "@jest/globals";
import { placeTextFor } from "./placeNames.ts";

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
