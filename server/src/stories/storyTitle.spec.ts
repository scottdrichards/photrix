import { describe, expect, it } from "@jest/globals";
import { folderTitle, parsePlace, placeTitle, storyTitle } from "./storyTitle.ts";
import type { StoryItem } from "./storyTypes.ts";

const item = (path: string, place: string | null = null): StoryItem => ({
  path,
  time: 0,
  lat: null,
  lon: null,
  place,
  isVideo: false,
  rating: null,
  quality: null,
  width: null,
  height: null,
  burstMember: false,
});

const places = (...texts: string[]) => texts.map((text) => parsePlace(text)!);
const times = (n: number, text: string) => Array.from({ length: n }, () => text);

describe("parsePlace", () => {
  it("reads the state of a US place and the country of any other", () => {
    expect(parsePlace("Boulder City, Nevada, United States, USA")).toEqual({
      city: "Boulder City",
      region: "Nevada",
      country: "United States",
    });
    expect(parsePlace("Rome, Italy")).toEqual({
      city: "Rome",
      region: "Italy",
      country: "Italy",
    });
    expect(parsePlace("")).toBeNull();
    expect(parsePlace(null)).toBeNull();
  });
});

describe("placeTitle", () => {
  it("names one city when nearly everything is there", () => {
    expect(placeTitle(places(...times(9, "Rome, Italy"), "Tivoli, Italy"))).toBe("Rome");
  });

  it("names two cities that together cover the trip", () => {
    expect(
      placeTitle(places(...times(9, "Rome, Italy"), ...times(3, "Florence, Italy"))),
    ).toBe("Rome & Florence");
  });

  it("steps out to states, then countries, when the cities are spread out", () => {
    const roadTrip = places(
      "Tusayan, Arizona, United States, USA",
      "Page, Arizona, United States, USA",
      "Boulder City, Nevada, United States, USA",
      "Twentynine Palms, California, United States, USA",
      "Malibu, California, United States, USA",
    );
    expect(placeTitle(roadTrip)).toBe("Arizona, Nevada & California");
    const europe = places(
      "Paris, France",
      "Lyon, France",
      "Rome, Italy",
      "Milan, Italy",
      "Bern, Switzerland",
      "Nice, France",
    );
    expect(placeTitle(europe)).toBe("France, Italy & Switzerland");
  });

  it("names places in the order they were visited, not by count", () => {
    expect(
      placeTitle(places(...times(3, "Florence, Italy"), ...times(9, "Rome, Italy"))),
    ).toBe("Florence & Rome");
  });

  it("has nothing to say without places", () => {
    expect(placeTitle([])).toBeNull();
  });
});

describe("folderTitle", () => {
  it("uses a shared folder's name, minus a leading date", () => {
    expect(
      folderTitle([
        item("/2019/2019-07-04 Fourth_of_July/a.jpg"),
        item("/2019/2019-07-04 Fourth_of_July/b.jpg"),
      ]),
    ).toBe("Fourth of July");
  });

  it("ignores folder names that say nothing", () => {
    expect(
      folderTitle([item("/DCIM/100APPLE/a.jpg"), item("/DCIM/100APPLE/b.jpg")]),
    ).toBeNull();
    expect(folderTitle([item("/2023/05/a.jpg"), item("/2023/05/b.jpg")])).toBeNull();
  });

  it("needs most items to share the folder", () => {
    expect(
      folderTitle([item("/Party/a.jpg"), item("/Other/b.jpg"), item("/Third/c.jpg")]),
    ).toBeNull();
  });
});

describe("storyTitle", () => {
  it("titles a trip by place and lists its cities, most photographed first", () => {
    const items = [...times(3, "Florence, Italy"), ...times(5, "Rome, Italy")].map(
      (place, i) => item(`/t/${i}.jpg`, place),
    );
    expect(storyTitle("trip", "2023-05-03", items, [])).toEqual({
      kicker: "Trip",
      title: "Florence & Rome",
      places: ["Rome", "Florence"],
    });
  });

  it("titles an event by its folder, then its people, then its date", () => {
    const people = [
      { name: "Alex", count: 9, face: null },
      { name: "Jordan", count: 4, face: null },
    ];
    expect(
      storyTitle(
        "event",
        "2023-07-04",
        [item("/Birthday/a.jpg"), item("/Birthday/b.jpg")],
        people,
      ).title,
    ).toBe("Birthday");
    expect(storyTitle("event", "2023-07-04", [item("/DCIM/a.jpg")], people).title).toBe(
      "With Alex & Jordan",
    );
    expect(storyTitle("event", "2023-07-04", [item("/DCIM/a.jpg")], [])).toEqual({
      kicker: "A big day",
      title: "Tuesday, July 4",
      places: [],
    });
  });
});
