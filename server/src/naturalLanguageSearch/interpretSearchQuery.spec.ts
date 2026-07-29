import { describe, expect, it, jest } from "@jest/globals";
import { interpretSearchQuery, type GenerateFn } from "./interpretSearchQuery.ts";
import type { SearchVocabulary } from "./searchVocabulary.ts";

const NOW = Date.UTC(2026, 6, 15, 12, 0, 0);

const vocabulary: SearchVocabulary = {
  people: [
    { name: "Sarah", clusterId: "person-12" },
    { name: "Ben", clusterId: "person-30" },
    { name: "Aunt May" },
  ],
  folders: ["Trips", "Family Archive", "Screenshots"],
};

/** A model that always answers with the given object (or raw string). */
const respondWith = (answer: unknown): GenerateFn =>
  jest.fn(async () =>
    typeof answer === "string" || answer === null ? answer : JSON.stringify(answer),
  ) as GenerateFn;

const interpret = (query: string, generate: GenerateFn) =>
  interpretSearchQuery({ query, vocabulary, now: NOW, generate });

describe("interpretSearchQuery", () => {
  it("turns a natural query into people, date and media filters plus leftover text", async () => {
    const result = await interpret(
      "photos of Sarah at the beach last summer",
      respondWith({
        people: ["Sarah"],
        mediaType: "photo",
        date: { kind: "season", season: "summer", yearsAgo: 1 },
        visual: "at the beach",
      }),
    );

    expect(result).toMatchObject({
      interpreted: true,
      query: "photos of Sarah at the beach last summer",
      filter: {
        faceClusterFilter: ["person-12"],
        mediaTypeFilter: "photo",
        dateRange: {
          start: Date.UTC(2025, 5, 1),
          end: Date.UTC(2025, 8, 1) - 1,
        },
        semanticQuery: "at the beach",
      },
      ignored: [],
    });
    expect(result.interpreted && result.chips.map((chip) => chip.label)).toEqual([
      "Sarah",
      "Photos only",
      "Summer 2025",
      "“at the beach”",
    ]);
  });

  it("maps a folder and video request onto the path filter", async () => {
    const result = await interpret(
      "videos from the Trips folder",
      respondWith({ folder: "Trips", mediaType: "video" }),
    );

    expect(result).toMatchObject({
      interpreted: true,
      filter: {
        path: "Trips/",
        includeSubfolders: true,
        mediaTypeFilter: "video",
        semanticQuery: undefined,
      },
    });
  });

  it("matches vocabulary case- and punctuation-insensitively", async () => {
    const result = await interpret(
      "aunt may in family archive",
      respondWith({ people: ["aunt  may"], folder: "family-archive" }),
    );

    expect(result).toMatchObject({
      interpreted: true,
      filter: { peopleInImageFilter: ["Aunt May"], path: "Family Archive/" },
      ignored: [],
    });
  });

  it("drops hallucinated people and folders instead of filtering on them", async () => {
    const result = await interpret(
      "photos of Gandalf and Sarah in Rivendell last summer",
      respondWith({
        people: ["Gandalf", "Sarah"],
        folder: "Rivendell",
        date: { kind: "season", season: "summer", yearsAgo: 1 },
      }),
    );

    expect(result).toMatchObject({
      interpreted: true,
      filter: { faceClusterFilter: ["person-12"] },
      ignored: ["Gandalf", "Rivendell"],
    });
    expect(result.interpreted && result.filter.path).toBeUndefined();
    expect(result.interpreted && result.filter.peopleInImageFilter).toBeUndefined();
  });

  it("drops an unusable date rather than guessing a range", async () => {
    const result = await interpret(
      "pictures of Ben around the equinox",
      respondWith({
        people: ["Ben"],
        date: { kind: "equinox", month: "whenever" },
      }),
    );

    expect(result).toMatchObject({
      interpreted: true,
      filter: { faceClusterFilter: ["person-30"] },
    });
    expect(result.interpreted && result.filter.dateRange).toBeUndefined();
  });

  it("parses the date from the query rather than trusting the model's", async () => {
    // The live 3B model answers "last summer" with an invented 2018-2019 range.
    const result = await interpret(
      "photos from last summer",
      respondWith({ date: { kind: "yearRange", startYear: 2018, endYear: 2019 } }),
    );

    expect(result).toMatchObject({
      interpreted: true,
      filter: {
        dateRange: { start: Date.UTC(2025, 5, 1), end: Date.UTC(2025, 8, 1) - 1 },
      },
    });
  });

  it("ignores absolute model timestamps entirely", async () => {
    const result = await interpret(
      "photos of a sunset",
      respondWith({ date: { start: 1_600_000_000_000, end: 1_700_000_000_000 } }),
    );
    expect(result.interpreted && result.filter.dateRange).toBeUndefined();
  });

  it("refuses a person the query never named, even a real one", async () => {
    // Observed live: "with the kids" came back as people ["Ben", "Aunt May"].
    const result = await interpret(
      "videos from the trip with the kids",
      respondWith({ people: ["Ben", "Aunt May"], mediaType: "video" }),
    );

    expect(result).toMatchObject({
      interpreted: true,
      filter: { mediaTypeFilter: "video" },
    });
    expect(result.interpreted && result.filter.faceClusterFilter).toBeUndefined();
    expect(result.interpreted && result.filter.peopleInImageFilter).toBeUndefined();
  });

  it("refuses a folder the query never named, even a real one", async () => {
    const result = await interpret(
      "photos of Sarah at the beach",
      respondWith({ folder: "Trips", people: ["Sarah"] }),
    );
    expect(result.interpreted && result.filter.path).toBeUndefined();
  });

  it("refuses a date when the query says nothing about time", async () => {
    // Observed live: "sunset over water" came back with a date object.
    const result = await interpret(
      "photos of a sunset over water",
      respondWith({
        date: { kind: "year", year: 2019 },
        visual: "sunset over water",
      }),
    );
    expect(result.interpreted && result.filter.dateRange).toBeUndefined();
  });

  it("accepts an absolute year only when the query spells it out", async () => {
    const withYear = await interpret(
      "photos of Sarah in 2019",
      respondWith({ people: ["Sarah"], date: { kind: "year", year: 2019 } }),
    );
    expect(withYear).toMatchObject({
      interpreted: true,
      filter: { dateRange: { start: Date.UTC(2019, 0, 1) } },
    });

    const inventedYear = await interpret(
      "photos of Sarah from a while ago",
      respondWith({ people: ["Sarah"], date: { kind: "year", year: 2019 } }),
    );
    expect(inventedYear.interpreted && inventedYear.filter.dateRange).toBeUndefined();
  });

  it("does not force a media type the query never asked for", async () => {
    const result = await interpret(
      "Sarah at the beach",
      respondWith({ people: ["Sarah"], mediaType: "photo" }),
    );
    expect(result.interpreted && result.filter.mediaTypeFilter).toBeUndefined();
  });

  it("does not apply a rating the query never asked for", async () => {
    const result = await interpret(
      "photos of Sarah at the beach",
      respondWith({ people: ["Sarah"], minRating: 4 }),
    );
    expect(result.interpreted && result.filter.ratingFilter).toBeUndefined();
  });

  it("reports the Ollama-unavailable path without failing the search", async () => {
    const generate = respondWith(null);
    expect(await interpret("photos of Sarah", generate)).toEqual({
      interpreted: false,
      reason: "unavailable",
    });
  });

  it("falls back when the model answers with prose instead of JSON", async () => {
    expect(
      await interpret("photos of Sarah", respondWith("Sure! Here are your photos.")),
    ).toEqual({ interpreted: false, reason: "malformed" });
  });

  it("falls back on truncated or invalid JSON", async () => {
    expect(
      await interpret("photos of Sarah", respondWith('{"people": ["Sarah"')),
    ).toEqual({ interpreted: false, reason: "malformed" });
  });

  it("recovers the object when the model wraps it in a fence or preamble", async () => {
    const result = await interpret(
      "videos of Sarah",
      respondWith('Here you go:\n```json\n{"people":["Sarah"],"mediaType":"video"}\n```'),
    );
    expect(result).toMatchObject({
      interpreted: true,
      filter: { faceClusterFilter: ["person-12"], mediaTypeFilter: "video" },
    });
  });

  it("falls back when the model returns a JSON array or scalar", async () => {
    expect(await interpret("photos of Sarah", respondWith('["Sarah"]'))).toEqual({
      interpreted: false,
      reason: "malformed",
    });
  });

  it("ignores junk field types instead of applying them", async () => {
    const result = await interpret(
      "five star photos of Sarah",
      respondWith({
        people: [{ name: "Sarah" }, 42, "Sarah"],
        mediaType: "hologram",
        minRating: "five",
        folder: 17,
        visual: { text: "beach" },
      }),
    );

    expect(result).toMatchObject({
      interpreted: true,
      filter: { faceClusterFilter: ["person-12"] },
    });
    expect(result.interpreted && result.filter.mediaTypeFilter).toBeUndefined();
    expect(result.interpreted && result.filter.ratingFilter).toBeUndefined();
    expect(result.interpreted && result.filter.semanticQuery).toBeUndefined();
  });

  it("clamps an out-of-range rating to the app's 1-5 scale", async () => {
    const result = await interpret(
      "my best photos",
      respondWith({ minRating: 9, visual: "best" }),
    );
    expect(result).toMatchObject({
      interpreted: true,
      filter: { ratingFilter: { rating: 5, atLeast: true } },
    });
  });

  it("treats a query with nothing structured in it as a plain search", async () => {
    expect(
      await interpret("sunset over water", respondWith({ visual: "sunset over water" })),
    ).toEqual({ interpreted: false, reason: "no-filters" });
  });

  it("does not call the model for an empty query", async () => {
    const generate = respondWith({ people: ["Sarah"] });
    expect(await interpret("   ", generate)).toEqual({
      interpreted: false,
      reason: "empty-query",
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it("refuses to interpret a pasted wall of text", async () => {
    const generate = respondWith({ people: ["Sarah"] });
    expect(await interpret("x".repeat(500), generate)).toEqual({
      interpreted: false,
      reason: "empty-query",
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it("survives a generator that throws", async () => {
    const generate = jest.fn(async () => {
      throw new Error("connection reset");
    }) as unknown as GenerateFn;
    expect(await interpret("photos of Sarah", generate)).toEqual({
      interpreted: false,
      reason: "error",
    });
  });

  it("grounds the prompt in the library's real people and folders", async () => {
    const generate = respondWith({ people: ["Sarah"] });
    await interpret("photos of Sarah", generate);

    const prompt = (generate as unknown as jest.Mock).mock.calls[0][1] as string;
    expect(prompt).toContain("Sarah, Ben, Aunt May");
    expect(prompt).toContain("Trips, Family Archive, Screenshots");
    expect(prompt).toContain("Request: photos of Sarah");
  });

  it("still works for a library with no named people or folders", async () => {
    const result = await interpretSearchQuery({
      query: "videos from last winter",
      vocabulary: { people: [], folders: [] },
      now: NOW,
      generate: respondWith({
        people: ["Sarah"],
        mediaType: "video",
        date: { kind: "season", season: "winter", yearsAgo: 1 },
      }),
    });

    expect(result).toMatchObject({
      interpreted: true,
      filter: { mediaTypeFilter: "video" },
      ignored: ["Sarah"],
    });
  });

  it("de-duplicates repeated names", async () => {
    const result = await interpret(
      "sarah and Sarah",
      respondWith({ people: ["Sarah", "sarah", "SARAH"] }),
    );
    expect(result).toMatchObject({
      interpreted: true,
      filter: { faceClusterFilter: ["person-12"] },
    });
    expect(result.interpreted && result.chips).toHaveLength(1);
  });
});
