import { describe, expect, it } from "@jest/globals";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { generateShareDescription } from "./generateShareDescription.ts";

const databaseWithNames = (names: Record<number, string>) =>
  ({
    getFaceClusterNames: (ids: number[]) =>
      Promise.resolve(
        new Map(ids.flatMap((id) => (names[id] ? [[id, names[id]] as const] : []))),
      ),
  }) as unknown as IndexDatabase;

// PHOTRIX_OLLAMA_URL is unset in the test env, so ollamaGenerate short-circuits
// to null and every call here exercises the deterministic fallback summary —
// exactly the path feedback #108/#109 were filed against.

describe("generateShareDescription (fallback summary, feedback #108/#109)", () => {
  it("leads with the people and glues a near-city fact onto them with a bare space", async () => {
    const filter = {
      operation: "and" as const,
      conditions: [
        { faceCluster: [7, 9, 11, 13] },
        {
          locationLatitude: { min: 40.6, max: 40.85 },
          locationLongitude: { min: -112.0, max: -111.75 },
        },
      ],
    };
    const database = databaseWithNames({
      7: "Sarah Richards",
      9: "Scott Richards",
      11: "Alice Richards",
      13: "Amelia Richards",
    });

    const description = await generateShareDescription({ filter, database });

    expect(description).toBe(
      "Sarah, Scott, Alice, and Amelia near Salt Lake City, UT",
    );
  });

  it("leads with the people and glues a coarsened date onto them with a bare space", async () => {
    const filter = {
      operation: "and" as const,
      conditions: [
        { faceCluster: [7, 9, 11, 13] },
        { dateTaken: { min: Date.UTC(2023, 11, 6), max: Date.UTC(2024, 11, 25) } },
      ],
    };
    const database = databaseWithNames({
      7: "Sarah Richards",
      9: "Scott Richards",
      11: "Alice Richards",
      13: "Amelia Richards",
    });

    const description = await generateShareDescription({ filter, database });

    expect(description).toBe("Sarah, Scott, Alice, and Amelia around 2024");
  });

  it("still separates non-leadIn facts with the dot bullet", async () => {
    const filter = {
      operation: "and" as const,
      conditions: [
        { faceCluster: [7] },
        { mimeType: { startsWith: "image/" } },
      ],
    };
    const database = databaseWithNames({ 7: "Ada Lovelace" });

    const description = await generateShareDescription({ filter, database });

    expect(description).toBe("Ada Lovelace · Photos only (no videos)");
  });
});
