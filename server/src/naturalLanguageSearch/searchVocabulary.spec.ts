import { describe, expect, it } from "@jest/globals";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { clearSearchVocabularyCache, loadSearchVocabulary } from "./searchVocabulary.ts";

const databaseWithFolders = (
  byPath: Record<string, Array<{ name: string; count: number }>>,
) =>
  ({
    getFolders: async (path: string) => byPath[path] ?? [],
    asyncSqlite: { all: async () => [] },
    queryFieldSuggestions: async () => [],
  }) as unknown as IndexDatabase;

describe("loadSearchVocabulary folders (feedback #111)", () => {
  it("expands top-level folders one level deep as 'Parent/Child' entries", async () => {
    clearSearchVocabularyCache();
    const database = databaseWithFolders({
      "/": [
        { name: "Trips", count: 500 },
        { name: "Screenshots", count: 10 },
      ],
      "/Trips/": [
        { name: "Beach Trip 2024", count: 80 },
        { name: "Ski Trip 2023", count: 40 },
      ],
      "/Screenshots/": [],
    });

    const vocabulary = await loadSearchVocabulary(database);

    expect(vocabulary.folders).toContain("Trips/Beach Trip 2024");
    expect(vocabulary.folders).toContain("Trips/Ski Trip 2023");
    expect(vocabulary.folders).toContain("Trips");
    expect(vocabulary.folders).toContain("Screenshots");
  });

  it("ranks all folders — top-level and nested — by count together, most populated first", async () => {
    clearSearchVocabularyCache();
    const database = databaseWithFolders({
      "/": [
        { name: "Trips", count: 500 },
        { name: "Tiny", count: 1 },
      ],
      "/Trips/": [{ name: "Huge Album", count: 490 }],
      "/Tiny/": [],
    });

    const vocabulary = await loadSearchVocabulary(database);

    const huge = vocabulary.folders.indexOf("Trips/Huge Album");
    const tiny = vocabulary.folders.indexOf("Tiny");
    expect(huge).toBeGreaterThanOrEqual(0);
    expect(tiny).toBeGreaterThanOrEqual(0);
    expect(huge).toBeLessThan(tiny);
  });

  it("tolerates a nested listing failure for one folder without losing the rest", async () => {
    clearSearchVocabularyCache();
    const database = {
      getFolders: async (path: string) => {
        if (path === "/") return [{ name: "Trips", count: 5 }, { name: "OK", count: 3 }];
        if (path === "/Trips/") throw new Error("boom");
        if (path === "/OK/") return [{ name: "Fine", count: 1 }];
        return [];
      },
      asyncSqlite: { all: async () => [] },
      queryFieldSuggestions: async () => [],
    } as unknown as IndexDatabase;

    const vocabulary = await loadSearchVocabulary(database);

    expect(vocabulary.folders).toContain("Trips");
    expect(vocabulary.folders).toContain("OK");
    expect(vocabulary.folders).toContain("OK/Fine");
  });
});
