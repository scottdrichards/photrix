import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import type {
  FilterCondition,
  FilterElement,
} from "../indexDatabase/indexDatabase.type.ts";
import { findNearbyCity } from "./majorCities.ts";

/**
 * One facet of a share filter, in plain English.
 *
 * `nameable` marks facts that carry something a title could actually be built
 * from. Contentless ones ("an area on the map") still belong in the written
 * summary, but handing them to a model invites it to fill the void — an
 * unnamed map area plus a 2024 date reliably became "European City Break".
 */
export type ShareFilterFact = { text: string; nameable: boolean };

/** Depth-first walk yielding every leaf condition of a filter tree. */
const leafConditions = (filter: FilterElement): FilterCondition[] =>
  "operation" in filter ? filter.conditions.flatMap(leafConditions) : [filter];

const formatDate = (value: unknown): string | null => {
  const date = new Date(value as string | number);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "UTC",
      });
};

const isRange = (value: unknown): value is { min?: unknown; max?: unknown } =>
  typeof value === "object" && value !== null && ("min" in value || "max" in value);

const list = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter(Boolean).join(", ") || null;
  if (typeof value === "object" && value !== null) {
    const { includes, startsWith } = value as Record<string, unknown>;
    return (
      (typeof includes === "string" && includes) ||
      (typeof startsWith === "string" && startsWith) ||
      null
    );
  }
  return null;
};

/**
 * Turns a share filter into plain-English facts, one per facet.
 *
 * This is the grounding fed to the model for titling, and doubles as the
 * description itself when no model is available — so it has to read acceptably
 * on its own, not just as prompt scaffolding.
 */
export const summarizeShareFilter = async (
  filter: FilterElement,
  database: IndexDatabase,
): Promise<ShareFilterFact[]> => {
  const facts: ShareFilterFact[] = [];
  const clusterIds = new Set<number>();
  const named = (text: string) => facts.push({ text, nameable: true });

  for (const condition of leafConditions(filter)) {
    // Feedback #86: when a condition carries a full lat/long bounding box
    // (the map view's pan/zoom filter), name the nearest major city rather
    // than leaving it as the deliberately vague "an area on the map" below.
    // This is a real nearest-neighbor lookup against a static list
    // (majorCities.ts), never coordinates handed to the model — see that
    // file's doc comment and the locationLatitude case below for why raw
    // lat/long reliably makes a small model hallucinate a city.
    let namedNearbyCity = false;
    const latRange = (condition as Record<string, unknown>).locationLatitude;
    const lonRange = (condition as Record<string, unknown>).locationLongitude;
    if (isRange(latRange) && isRange(lonRange)) {
      const { min: latMin, max: latMax } = latRange;
      const { min: lonMin, max: lonMax } = lonRange;
      if (
        typeof latMin === "number" &&
        typeof latMax === "number" &&
        typeof lonMin === "number" &&
        typeof lonMax === "number"
      ) {
        const city = findNearbyCity((latMin + latMax) / 2, (lonMin + lonMax) / 2);
        if (city) {
          named(`Near ${city.name}, ${city.region}`);
          namedNearbyCity = true;
        }
      }
    }

    for (const [field, value] of Object.entries(condition)) {
      if (value == null && field !== "mimeType") continue;

      switch (field) {
        case "folder": {
          const folder =
            typeof value === "object" && value !== null && "folder" in value
              ? String((value as { folder: unknown }).folder)
              : list(value);
          if (folder && folder !== "/") {
            const recursive =
              typeof value === "object" && value !== null && "recursive" in value
                ? (value as { recursive?: boolean }).recursive !== false
                : true;
            named(
              `Album folder: ${folder}${recursive ? " (including subfolders)" : " (that folder only)"}`,
            );
          }
          break;
        }

        // Phrased as favourites rather than "star rating": the latter dragged
        // titles toward review language ("Sunset Beach Reviews").
        case "rating":
          if (isRange(value)) {
            const { min, max } = value;
            if (min != null && max != null)
              named(`Only favorites, between ${String(min)} and ${String(max)} stars`);
            else if (min != null) named(`Only favorites, ${String(min)} stars or more`);
            else named(`Only up to ${String(max)} stars`);
          } else if (typeof value === "number") {
            named(`Only favorites, exactly ${value} stars`);
          }
          break;

        case "mimeType": {
          const startsWith = (value as { startsWith?: string } | null)?.startsWith;
          // The "other" media type expands to a nest of notStartsWith/null
          // conditions; only the positive photo/video cases are worth naming.
          if (startsWith === "image/") named("Photos only (no videos)");
          else if (startsWith === "video/") named("Videos only");
          break;
        }

        case "dateTaken": {
          if (!isRange(value)) break;
          const min = value.min == null ? null : formatDate(value.min);
          const max = value.max == null ? null : formatDate(value.max);
          if (min && max) named(`Taken between ${min} and ${max}`);
          else if (min) named(`Taken on or after ${min}`);
          else if (max) named(`Taken on or before ${max}`);
          break;
        }

        case "faceCluster":
          for (const id of Array.isArray(value) ? value : [value]) {
            if (typeof id === "number") clusterIds.add(id);
          }
          break;

        case "personInImage": {
          const people = list(value);
          if (people) named(`People tagged in the photo: ${people}`);
          break;
        }

        case "cameraModel": {
          const camera = list(value);
          if (camera) named(`Shot on camera: ${camera}`);
          break;
        }

        case "lens": {
          const lens = list(value);
          if (lens) named(`Shot with lens: ${lens}`);
          break;
        }

        // Deliberately coordinate-free: a small model reads latitude/longitude
        // as an invitation to name a city, and gets it wrong (47.61/-122.33 is
        // Seattle; it answered "Portland Oregon Photos"). The nearby-city
        // lookup above is the grounded alternative — this stays as the
        // fallback for when that lookup found nothing within range.
        case "locationLatitude":
          if (isRange(value) && !namedNearbyCity)
            facts.push({ text: "Limited to one area on the map", nameable: false });
          break;
      }
    }
  }

  if (clusterIds.size > 0) {
    const names = await database.getFaceClusterNames([...clusterIds]);
    const people = [...clusterIds]
      .map((id) => names.get(id))
      .filter((name): name is string => Boolean(name));
    facts.push(
      people.length > 0
        ? {
            text: `Photos of these recognized people: ${people.join(", ")}`,
            nameable: true,
          }
        : {
            text: `Photos of ${clusterIds.size} specific ${clusterIds.size === 1 ? "person" : "people"} (names not set)`,
            nameable: false,
          },
    );
  }

  return facts;
};
