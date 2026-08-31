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
  folders: ["Trips", "Family Archive", "Screenshots", "Trips/Beach Trip 2024"],
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

  it("matches a nested folder when the model echoes the full compound path (feedback #111)", async () => {
    const result = await interpret(
      "Beach trip 2024 photos",
      respondWith({ folder: "Trips/Beach Trip 2024", mediaType: "photo" }),
    );

    expect(result).toMatchObject({
      interpreted: true,
      filter: {
        path: "Trips/Beach Trip 2024/",
        includeSubfolders: true,
      },
    });
    expect(result.interpreted && result.chips.map((chip) => chip.label)).toContain(
      "Folder: Trips/Beach Trip 2024",
    );
  });

  it("matches a nested folder when the model echoes only the leaf name (feedback #111)", async () => {
    // Realistic case: the query never mentions the parent category ("Trips")
    // at all, and the model reasonably doesn't invent it either.
    const result = await interpret(
      "Beach trip 2024 photos",
      respondWith({ folder: "Beach Trip 2024", mediaType: "photo" }),
    );

    expect(result).toMatchObject({
      interpreted: true,
      filter: { path: "Trips/Beach Trip 2024/", includeSubfolders: true },
    });
  });

  it("still refuses a nested folder the query never actually names", async () => {
    const result = await interpret(
      "photos from last year",
      respondWith({ folder: "Beach Trip 2024" }),
    );

    expect(result.interpreted && result.filter.path).toBeUndefined();
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

  it("resolves a partial name against a longer vocabulary name (model echoes the query word)", async () => {
    // A small local model is told to copy names "exactly from the People
    // list", but for "Sarah haircut" against a vocabulary entry "Sarah
    // Johnson Richards" it often just echoes back the query's own word
    // instead of expanding it. The filter must still apply — otherwise the
    // search silently degrades to a person-blind CLIP query on "haircut".
    const fullNameVocabulary: SearchVocabulary = {
      people: [{ name: "Sarah Johnson Richards", clusterId: "person-99" }],
      folders: [],
    };
    const result = await interpretSearchQuery({
      query: "Sarah haircut",
      vocabulary: fullNameVocabulary,
      now: NOW,
      generate: respondWith({ people: ["Sarah"], visual: "haircut" }),
    });

    expect(result).toMatchObject({
      interpreted: true,
      filter: { faceClusterFilter: ["person-99"], semanticQuery: "haircut" },
      ignored: [],
    });
  });

  it("resolves a mangled multi-word name (model truncates rather than copies)", async () => {
    // Observed live against the real vocabulary/model: for "sarah haircut"
    // with a "Sarah Johnson Richards" cluster in the People list, the model
    // answered `{"people": "Sarah Johnson"}` — a plausible-looking two-word
    // truncation that drops "Richards" entirely, not just a missing single
    // word. A same-name person elsewhere with only "Johnson" in common must
    // not match this alone (see the ambiguous case below), but "Sarah
    // Johnson" together is specific enough to resolve uniquely.
    const fullNameVocabulary: SearchVocabulary = {
      people: [
        { name: "Sarah Johnson Richards", clusterId: "person-99" },
        { name: "Diane Earl Johnson", clusterId: "person-100" },
      ],
      folders: [],
    };
    const result = await interpretSearchQuery({
      query: "sarah haircut",
      vocabulary: fullNameVocabulary,
      now: NOW,
      generate: respondWith({ people: "Sarah Johnson", visual: "haircut" }),
    });

    expect(result).toMatchObject({
      interpreted: true,
      filter: { faceClusterFilter: ["person-99"], semanticQuery: "haircut" },
      ignored: [],
    });
  });

  it("does not guess when a partial name is ambiguous between two vocabulary people", async () => {
    const ambiguousVocabulary: SearchVocabulary = {
      people: [
        { name: "Sarah Johnson Richards", clusterId: "person-99" },
        { name: "Sarah Connor", clusterId: "person-100" },
      ],
      folders: [],
    };
    const result = await interpretSearchQuery({
      query: "Sarah haircut",
      vocabulary: ambiguousVocabulary,
      now: NOW,
      generate: respondWith({ people: ["Sarah"], visual: "haircut" }),
    });

    // No structured filter survives (the ambiguous name is rightly dropped),
    // so this falls back to `interpreted: false` and the plain CLIP search on
    // the raw query stands, exactly as if the model had answered nothing at
    // all.
    expect(result).toEqual({ interpreted: false, reason: "no-filters" });
  });

  it("does not guess a single word shared by two multi-word vocabulary names", async () => {
    const sharedWordVocabulary: SearchVocabulary = {
      people: [
        { name: "Sarah Johnson Richards", clusterId: "person-99" },
        { name: "Diane Earl Johnson", clusterId: "person-100" },
      ],
      folders: [],
    };
    const result = await interpretSearchQuery({
      query: "johnson family reunion",
      vocabulary: sharedWordVocabulary,
      now: NOW,
      generate: respondWith({ people: "Johnson" }),
    });

    expect(result).toEqual({ interpreted: false, reason: "no-filters" });
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

    // "Sarah" has zero textual support in this query — a pure hallucination,
    // not something worth surfacing to the user as "ignored".
    expect(result).toMatchObject({
      interpreted: true,
      filter: { mediaTypeFilter: "video" },
      ignored: [],
    });
  });

  it("reports an unmatched name as ignored only when the query actually names it", async () => {
    const result = await interpretSearchQuery({
      query: "videos of Sarah from last winter",
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

  it("resolves every person named, not just the first", async () => {
    const twoPeopleVocabulary: SearchVocabulary = {
      people: [
        { name: "Alice Diane Richards", clusterId: "person-969" },
        { name: "Amelia Jean Richards", clusterId: "person-1182" },
      ],
      folders: [],
    };
    const result = await interpretSearchQuery({
      query: "alice holding amelias hand",
      vocabulary: twoPeopleVocabulary,
      now: NOW,
      generate: respondWith({ people: ["Alice", "Amelia"], visual: "holding hands" }),
    });

    expect(result).toMatchObject({
      interpreted: true,
      filter: {
        faceClusterFilter: expect.arrayContaining(["person-969", "person-1182"]),
        semanticQuery: "holding hands",
      },
      ignored: [],
    });
    expect(
      result.interpreted && (result.filter.faceClusterFilter as string[]),
    ).toHaveLength(2);
  });

  it("splits a comma-joined single string into separate people (model answers a scalar instead of an array)", async () => {
    // Observed live: asked for multiple people, the 3B model sometimes answers
    // `"people": "Scott Douglas Richards,Linda Simmons Richards"` — one string
    // instead of an array. No vocabulary name contains a comma, so splitting
    // recovers both rather than failing to match the combined string at all.
    const twoPeopleVocabulary: SearchVocabulary = {
      people: [
        { name: "Scott Douglas Richards", clusterId: "person-86" },
        { name: "Linda Simmons Richards", clusterId: "person-7" },
      ],
      folders: [],
    };
    const result = await interpretSearchQuery({
      query: "scott and linda at the beach",
      vocabulary: twoPeopleVocabulary,
      now: NOW,
      generate: respondWith({
        people: "Scott Douglas Richards,Linda Simmons Richards",
        visual: "beach",
      }),
    });

    expect(result).toMatchObject({
      interpreted: true,
      filter: {
        faceClusterFilter: expect.arrayContaining(["person-86", "person-7"]),
      },
      ignored: [],
    });
    expect(
      result.interpreted && (result.filter.faceClusterFilter as string[]),
    ).toHaveLength(2);
  });
});
