import { describe, expect, it } from "@jest/globals";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { summarizeShareFilter } from "./summarizeShareFilter.ts";

const databaseWithNames = (names: Record<number, string>) =>
  ({
    getFaceClusterNames: (ids: number[]) =>
      Promise.resolve(
        new Map(ids.flatMap((id) => (names[id] ? [[id, names[id]] as const] : []))),
      ),
  }) as unknown as IndexDatabase;

const emptyDatabase = databaseWithNames({});

const textOf = async (
  filter: Parameters<typeof summarizeShareFilter>[0],
  database = emptyDatabase,
) => (await summarizeShareFilter(filter, database)).map(({ text }) => text);

describe("summarizeShareFilter", () => {
  it("describes an empty filter as having no facets", async () => {
    expect(await summarizeShareFilter({}, emptyDatabase)).toEqual([]);
  });

  it("flattens nested and/or conditions into one list of facts", async () => {
    expect(
      await textOf({
        operation: "and",
        conditions: [
          { folder: { folder: "/Trips/Italy", recursive: true } },
          { rating: { min: 4 } },
          { mimeType: { startsWith: "image/" } },
        ],
      }),
    ).toEqual([
      "Album folder: /Trips/Italy (including subfolders)",
      "Only favorites, 4 stars or more",
      "Photos only (no videos)",
    ]);
  });

  it("formats a date-taken range in both bounded and half-open forms", async () => {
    expect(
      await textOf({
        dateTaken: { min: Date.UTC(2023, 5, 1), max: Date.UTC(2023, 5, 14) },
      }),
    ).toEqual(["Taken between June 1, 2023 and June 14, 2023"]);

    expect(await textOf({ dateTaken: { min: Date.UTC(2023, 5, 1) } })).toEqual([
      "Taken on or after June 1, 2023",
    ]);
  });

  it("resolves face-cluster ids to the people's names", async () => {
    expect(
      await textOf({ faceCluster: [7, 9] }, databaseWithNames({ 7: "Ada", 9: "Grace" })),
    ).toEqual(["Photos of these recognized people: Ada, Grace"]);
  });

  it("skips the mimeType nest produced by the 'other' media type", async () => {
    expect(
      await textOf({
        operation: "or",
        conditions: [{ mimeType: null }, { mimeType: { notStartsWith: "image/" } }],
      }),
    ).toEqual([]);
  });

  it("marks facets a title cannot be built from as not nameable", async () => {
    // A bare map area and an unnamed cluster describe the share accurately but
    // give a model nothing to name — it invents a destination if they are sent.
    expect(
      await summarizeShareFilter(
        {
          operation: "and",
          conditions: [
            { locationLatitude: { min: 47.5, max: 47.72 } },
            { locationLongitude: { min: -122.44, max: -122.22 } },
            { faceCluster: [7, 9] },
          ],
        },
        emptyDatabase,
      ),
    ).toEqual([
      { text: "Limited to one area on the map", nameable: false },
      { text: "Photos of 2 specific people (names not set)", nameable: false },
    ]);
  });
});
