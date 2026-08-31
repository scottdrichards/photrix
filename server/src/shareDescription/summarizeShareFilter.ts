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
export type ShareFilterFact = {
  text: string;
  nameable: boolean;
  /**
   * Feedback #108/#109: "near Salt Lake City" and "around 2024" read as
   * modifiers on *who's in the photos*, not standalone facts — joining them
   * with the usual " · " separator ("Sarah, Scott · near Salt Lake City")
   * doubled up on punctuation, since the fallback summary already needs to
   * read as a single flowing phrase once spliced into the header tagline
   * ("...view photos of {summary}"). A `leadIn` fact glues onto whatever
   * came immediately before it with a plain space instead.
   */
  leadIn?: boolean;
};

/** Depth-first walk yielding every leaf condition of a filter tree. */
const leafConditions = (filter: FilterElement): FilterCondition[] =>
  "operation" in filter ? filter.conditions.flatMap(leafConditions) : [filter];

const isRange = (value: unknown): value is { min?: unknown; max?: unknown } =>
  typeof value === "object" && value !== null && ("min" in value || "max" in value);

const yearOf = (value: unknown): number | null => {
  const date = new Date(value as string | number);
  return Number.isNaN(date.getTime()) ? null : date.getUTCFullYear();
};

/**
 * Feedback #109: a full "Taken between December 6, 2023 and December 25,
 * 2024" is more precision than a one-line description needs — "one level of
 * depth" (just the year) reads better once it's a modifier tacked onto a
 * name list. Falls back to the exact dates if either bound can't be parsed
 * to a year at all, which shouldn't happen in practice but keeps this total.
 */
const coarseDatePhrase = (min: unknown, max: unknown): string | null => {
  const minYear = min == null ? null : yearOf(min);
  const maxYear = max == null ? null : yearOf(max);
  if (minYear != null && maxYear != null) {
    return minYear === maxYear ? `in ${maxYear}` : `around ${maxYear}`;
  }
  if (minYear != null) return `since ${minYear}`;
  if (maxYear != null) return `up to ${maxYear}`;
  return null;
};

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

/** First token of a full name — used once there's more than one person to list. */
const firstName = (name: string): string => name.trim().split(/\s+/)[0] ?? name;

/**
 * "Jeffrey", "Jeffrey and Jonathan", "Jeffrey, Jonathan, and Benjamin" — an
 * Oxford-comma join with the given conjunction, matching the two/three+
 * cases people actually read naturally. `names` must already be non-empty.
 */
const joinNames = (names: string[], conjunction: "and" | "or"): string => {
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} ${conjunction} ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, ${conjunction} ${names[names.length - 1]}`;
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
  const named = (text: string, leadIn = false) =>
    facts.push({ text, nameable: true, ...(leadIn ? { leadIn: true } : {}) });
  // Feedback #102/#106: `{ faceCluster: [id1, id2] }` (one leaf, an array
  // value) is the "all of these people" shape the UI emits by default;
  // `{ operation: "or", conditions: [{faceCluster: id1}, {faceCluster: id2}] }`
  // (several single-id leaves) is "any of these people". That's the only
  // structural difference this flattened leaf walk preserves, so it's what
  // decides "and" vs "or" below rather than needing the discarded operation
  // tree itself.
  let facesFromArrayLeaf = false;
  let facesLeafCount = 0;

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
          // Feedback #108: lowercase and "leadIn" so this reads as
          // "{people} near {city}" rather than a standalone sentence.
          named(`near ${city.name}, ${city.region}`, true);
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
          const phrase = coarseDatePhrase(value.min, value.max);
          // Feedback #109: "leadIn" like the near-city fact above — reads as
          // "{people} around 2024", one level of depth instead of exact dates.
          if (phrase) named(phrase, true);
          break;
        }

        case "faceCluster":
          facesLeafCount += 1;
          if (Array.isArray(value)) facesFromArrayLeaf = true;
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
    // Feedback #106: this fact is often the whole description, spliced
    // straight into "A better way to view photos of {description}" — so it
    // has to read as a bare noun phrase ("Jeffrey, Jonathan, and Benjamin"),
    // not a full sentence with its own "Photos of..." lead-in, which
    // doubled up once concatenated. Multiple people are named by first name
    // only (full names get long fast); a single person keeps their full
    // stored name since there's no ambiguity to trim for.
    //
    // Feedback #108/#109: unshifted to the front rather than appended, so
    // "who" leads and any leadIn facts (near-city, coarse date) read as
    // modifiers on them — "Sarah, Scott, Alice, and Amelia near Salt Lake
    // City, UT" / "...around 2024" — instead of trailing behind an
    // unrelated-sounding location or date fact.
    const conjunction = !facesFromArrayLeaf && facesLeafCount > 1 ? "or" : "and";
    facts.unshift(
      people.length > 0
        ? {
            text: joinNames(
              people.length > 1 ? people.map(firstName) : people,
              conjunction,
            ),
            nameable: true,
          }
        : {
            text: `${clusterIds.size} specific ${clusterIds.size === 1 ? "person" : "people"} (names not set)`,
            nameable: false,
          },
    );
  }

  return facts;
};
