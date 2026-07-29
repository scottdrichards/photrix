import { describe, expect, it } from "@jest/globals";
import {
  extractDateIntent,
  hasTemporalEvidence,
  mediaTypeEvidence,
  queryMentions,
  ratingEvidence,
} from "./queryEvidence.ts";
import { resolveDateIntent } from "./resolveDateIntent.ts";

const NOW = Date.UTC(2026, 6, 15, 12, 0, 0);

const labelFor = (query: string) => {
  const intent = extractDateIntent(query, NOW);
  if (!intent) return null;
  return resolveDateIntent(intent, NOW)?.label ?? null;
};

describe("queryMentions", () => {
  it("matches a name the user typed, in any case", () => {
    expect(queryMentions("photos of sarah at the beach", "Sarah")).toBe(true);
    expect(queryMentions("Photos of SARAH", "Sarah")).toBe(true);
  });

  it("tolerates possessives and plurals", () => {
    expect(queryMentions("sarah's birthday", "Sarah")).toBe(true);
    expect(queryMentions("the Portland trip", "Trips")).toBe(true);
  });

  it("rejects a name the user never typed", () => {
    expect(queryMentions("videos from the trip with the kids", "Ben")).toBe(false);
    expect(queryMentions("videos from the trip with the kids", "Aunt May")).toBe(false);
  });

  it("does not match a name hidden inside a longer word", () => {
    expect(queryMentions("photos of the bench in the park", "Ben")).toBe(false);
  });

  it("requires every significant word of a multi-word name", () => {
    expect(queryMentions("aunt may at the lake", "Aunt May")).toBe(true);
    expect(queryMentions("family photos", "Family Archive")).toBe(false);
    expect(queryMentions("in my family archive", "Family Archive")).toBe(true);
  });
});

describe("mediaTypeEvidence", () => {
  it("reads the media word out of the query", () => {
    expect(mediaTypeEvidence("videos from the trip")).toBe("video");
    expect(mediaTypeEvidence("pictures of Sarah")).toBe("photo");
    expect(mediaTypeEvidence("clips of the dog")).toBe("video");
  });

  it("is silent when the query does not say", () => {
    expect(mediaTypeEvidence("sunset over water")).toBeNull();
    expect(mediaTypeEvidence("photos and videos of Sarah")).toBeNull();
  });
});

describe("ratingEvidence", () => {
  it("only fires when the query talks about quality", () => {
    expect(ratingEvidence("5 star photos")).toBe(true);
    expect(ratingEvidence("my best shots of Ben")).toBe(true);
    expect(ratingEvidence("photos of Ben")).toBe(false);
  });
});

describe("hasTemporalEvidence", () => {
  it.each([
    "photos from last summer",
    "pictures taken in 2019",
    "two Christmases ago",
    "videos from the past month",
    "photos from yesterday",
  ])("recognizes %s as temporal", (query) => {
    expect(hasTemporalEvidence(query)).toBe(true);
  });

  it.each(["sunset over water", "photos of Sarah at the beach", "the dog in the park"])(
    "does not read a date into %s",
    (query) => {
      expect(hasTemporalEvidence(query)).toBe(false);
    },
  );
});

describe("extractDateIntent", () => {
  it("parses seasons with their relative anchor", () => {
    expect(labelFor("photos of Sarah at the beach last summer")).toBe("Summer 2025");
    expect(labelFor("this winter")).toBe("Winter 2026");
    expect(labelFor("three summers ago")).toBe("Summer 2023");
  });

  it("parses holidays, including the two-word new year", () => {
    expect(labelFor("two Christmases ago")).toBe("Christmas 2024");
    expect(labelFor("halloween photos")).toBe("Halloween 2025");
    // Asked in July 2026: the new year just gone is January 2026's, and the
    // Christmas just gone is December 2025's.
    expect(labelFor("last new years")).toBe("New Year 2026");
    expect(labelFor("last christmas")).toBe("Christmas 2025");
    // ...but this summer is still running, so "last summer" is a year back.
    expect(labelFor("last summer")).toBe("Summer 2025");
  });

  it("parses explicit years and year ranges", () => {
    expect(labelFor("pictures from 2019")).toBe("2019");
    expect(labelFor("between 2015 and 2018")).toBe("2015–2018");
    expect(labelFor("July 2019")).toBe("July 2019");
  });

  it("parses bare and relative months", () => {
    expect(labelFor("photos from december")).toBe("December 2025");
    expect(labelFor("shots from last march")).toBe("March 2026");
  });

  it("parses rolling windows", () => {
    expect(labelFor("photos from the last 30 days")).toBe("Last 30 days");
    expect(labelFor("videos from the past two weeks")).toBe("Last 2 weeks");
    expect(labelFor("last year")).toBe("2025");
  });

  it("finds nothing in a query with no date phrasing", () => {
    expect(extractDateIntent("sunset over water", NOW)).toBeNull();
    expect(extractDateIntent("photos of Sarah at the beach", NOW)).toBeNull();
  });
});
