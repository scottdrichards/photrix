import type {
  InterpretedFilterChip,
  InterpretedSearchFilter,
  SearchInterpretation,
} from "../../../shared/filter-contract/src/index.ts";
import { getLogger } from "../observability/logger.ts";
import { ollamaGenerate } from "../shareDescription/ollamaGenerate.ts";
import {
  extractDateIntent,
  hasTemporalEvidence,
  mediaTypeEvidence,
  queryMentions,
  ratingEvidence,
  yearsInQuery,
} from "./queryEvidence.ts";
import { resolveDateIntent } from "./resolveDateIntent.ts";
import type { SearchVocabulary } from "./searchVocabulary.ts";

const log = getLogger("interpretSearchQuery");

/**
 * The interpretation runs *alongside* the plain search the user already
 * triggered, so missing this deadline costs nothing but the chips.
 *
 * 12s is measured, not arbitrary: the Ollama host answers a trivial prompt in
 * 4-11s depending on load, so a shorter deadline throws away most real answers
 * while a longer one leaves a stale request in flight after the user has moved
 * on. Raise it on a faster host; the client's own abort sits above it.
 */
const TIMEOUT_MS = Number(process.env.PHOTRIX_NL_SEARCH_TIMEOUT_MS) || 12_000;

/** Enough tokens for the JSON object below; anything longer is a runaway answer. */
const NUM_PREDICT = 120;

/** Longest query worth sending — beyond this it is a paste, not a search. */
const MAX_QUERY_LENGTH = 200;

/** Cap on the leftover free-text handed to CLIP. */
const MAX_VISUAL_LENGTH = 120;

// Kept deliberately short. The Ollama box prices a request mostly by prompt
// length — the original three-times-longer prompt (which also taught the model a
// date grammar) measured 30s per query against 3s for a small one, and dates are
// parsed from the query text here anyway, far more reliably than the 3B model
// managed. So the model is asked for only what it is actually good at: spotting
// which known person/folder a sentence refers to and what is left describing the
// picture. Anything it does return is still validated and evidence-checked.
const SYSTEM_PROMPT = `Convert a photo search request into JSON. Reply with one JSON object, nothing else.

Keys, all optional — omit any that do not apply:
"people": names copied exactly from the People list
"folder": one name copied exactly from the Folders list
"mediaType": "photo" or "video"
"minRating": 1-5
"visual": what the picture shows (scene, objects, activity)

Never invent a person or folder that is not on the lists. Keep names, dates, folders and media words out of "visual".`;

type RawInterpretation = {
  people?: unknown;
  folder?: unknown;
  mediaType?: unknown;
  minRating?: unknown;
  date?: unknown;
  visual?: unknown;
};

/** Injectable so tests exercise the schema/grounding logic without a model. */
export type GenerateFn = (
  system: string,
  prompt: string,
  options: { numPredict: number; timeoutMs: number; json: boolean },
) => Promise<string | null>;

const buildPrompt = (query: string, vocabulary: SearchVocabulary): string => {
  const people = vocabulary.people.map(({ name }) => name);
  return [
    people.length > 0 ? `People list: ${people.join(", ")}` : "People list: (none)",
    vocabulary.folders.length > 0
      ? `Folders list: ${vocabulary.folders.join(", ")}`
      : "Folders list: (none)",
    "",
    `Request: ${query}`,
    "JSON:",
  ].join("\n");
};

/**
 * Pull the JSON object out of a model answer.
 *
 * Even in JSON mode a small model prepends prose or wraps the object in a fence
 * often enough to matter, so take the outermost braces rather than trusting the
 * whole string to parse.
 */
const parseJsonObject = (text: string): RawInterpretation | null => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as RawInterpretation;
  } catch {
    return null;
  }
};

/** Match loosely enough to survive case and punctuation, never loosely enough to guess. */
const normalizeForMatch = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();

const asStringList = (value: unknown): string[] => {
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return values
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry.length <= 80);
};

const dedupe = (values: string[]) => [...new Set(values)];

export type InterpretOptions = {
  query: string;
  vocabulary: SearchVocabulary;
  /** Request time — relative dates resolve against this, never a build constant. */
  now?: number;
  generate?: GenerateFn;
};

/**
 * Translate a natural-language search into the app's structured filters.
 *
 * Everything the model produces is treated as a suggestion that must survive
 * validation: names and folders have to exist in the supplied vocabulary, dates
 * are re-derived here from a relative intent, and any field that fails is
 * dropped (and reported in `ignored`) rather than applied. When nothing
 * survives — or the model is unavailable, slow, or answers with garbage — the
 * result is `interpreted: false` and the caller runs the query as a plain
 * semantic search, exactly as before this feature existed.
 */
export const interpretSearchQuery = async ({
  query,
  vocabulary,
  now = Date.now(),
  generate = ollamaGenerate,
}: InterpretOptions): Promise<SearchInterpretation> => {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return { interpreted: false, reason: "empty-query" };
  if (trimmedQuery.length > MAX_QUERY_LENGTH) {
    return { interpreted: false, reason: "empty-query" };
  }

  let answer: string | null;
  try {
    answer = await generate(SYSTEM_PROMPT, buildPrompt(trimmedQuery, vocabulary), {
      numPredict: NUM_PREDICT,
      timeoutMs: TIMEOUT_MS,
      json: true,
    });
  } catch (error) {
    // ollamaGenerate swallows its own failures, but a stubbed/other generator
    // may throw; a search must never fail because of the enhancement path.
    log.warn({ err: error }, "query interpretation failed");
    return { interpreted: false, reason: "error" };
  }

  if (!answer) return { interpreted: false, reason: "unavailable" };

  const raw = parseJsonObject(answer);
  if (!raw) {
    log.warn({ answer: answer.slice(0, 200) }, "query interpretation was not JSON");
    return { interpreted: false, reason: "malformed" };
  }

  const filter: InterpretedSearchFilter = {};
  const chips: InterpretedFilterChip[] = [];
  const ignored: string[] = [];

  // People — only names that exist in this library. A named face cluster wins
  // over the metadata tag: it filters on recognized faces rather than on
  // whatever the file happened to be tagged with.
  const peopleByName = new Map(
    vocabulary.people.map((person) => [normalizeForMatch(person.name), person]),
  );
  const clusterIds: string[] = [];
  const taggedNames: string[] = [];
  for (const requested of dedupe(asStringList(raw.people))) {
    const match = peopleByName.get(normalizeForMatch(requested));
    if (!match) {
      ignored.push(requested);
      continue;
    }
    // A real person the user never asked for is the worst case: the filter looks
    // legitimate and quietly empties the grid. Require the name in the query.
    if (!queryMentions(trimmedQuery, match.name)) continue;
    if (match.clusterId) {
      if (!clusterIds.includes(match.clusterId)) {
        clusterIds.push(match.clusterId);
        chips.push({
          field: "faceClusterFilter",
          label: match.name,
          value: match.clusterId,
        });
      }
    } else if (!taggedNames.includes(match.name)) {
      taggedNames.push(match.name);
      chips.push({
        field: "peopleInImageFilter",
        label: match.name,
        value: match.name,
      });
    }
  }
  if (clusterIds.length > 0) filter.faceClusterFilter = clusterIds;
  if (taggedNames.length > 0) filter.peopleInImageFilter = taggedNames;

  // Folder — must be a real top-level folder *and* be named in the query. The
  // model happily answers "Trips" for any query about a trip.
  if (typeof raw.folder === "string" && raw.folder.trim()) {
    const requested = raw.folder.trim();
    const match = vocabulary.folders.find(
      (folder) => normalizeForMatch(folder) === normalizeForMatch(requested),
    );
    if (!match) {
      ignored.push(requested);
    } else if (queryMentions(trimmedQuery, match)) {
      filter.path = `${match}/`;
      filter.includeSubfolders = true;
      chips.push({ field: "path", label: `Folder: ${match}` });
    }
  }

  // Media type: the query has to actually say "photos" or "videos". Left to
  // itself the model answers "photo" for every query, which hides all videos.
  const mediaType = mediaTypeEvidence(trimmedQuery);
  if (mediaType && (raw.mediaType === mediaType || raw.mediaType === undefined)) {
    filter.mediaTypeFilter = mediaType;
    chips.push({
      field: "mediaTypeFilter",
      label: mediaType === "photo" ? "Photos only" : "Videos only",
    });
  }

  if (
    typeof raw.minRating === "number" &&
    Number.isFinite(raw.minRating) &&
    raw.minRating >= 1 &&
    ratingEvidence(trimmedQuery)
  ) {
    const rating = Math.min(5, Math.round(raw.minRating));
    filter.ratingFilter = { rating, atLeast: true };
    chips.push({ field: "ratingFilter", label: `${rating}+ stars` });
  }

  // Dates come from the query's own wording first. The model is a fallback for
  // phrasings the parser misses, and only when the query is temporal at all and
  // any absolute year it claims is literally written in the query.
  const dateIntent = extractDateIntent(trimmedQuery, now);
  const modelDateIsCredible = (intent: unknown): boolean => {
    if (!hasTemporalEvidence(trimmedQuery)) return false;
    const kind = (intent as { kind?: unknown }).kind;
    if (kind !== "year" && kind !== "yearRange") return true;
    const claimed = intent as { year?: number; startYear?: number; endYear?: number };
    const written = new Set(yearsInQuery(trimmedQuery));
    return [claimed.year, claimed.startYear, claimed.endYear]
      .filter((year): year is number => typeof year === "number")
      .every((year) => written.has(year));
  };

  const proposedDate =
    dateIntent ??
    (raw.date !== undefined && raw.date !== null && modelDateIsCredible(raw.date)
      ? raw.date
      : null);
  if (proposedDate !== null) {
    const resolved = resolveDateIntent(proposedDate, now);
    if (resolved) {
      filter.dateRange = { start: resolved.start, end: resolved.end };
      chips.push({ field: "dateRange", label: resolved.label });
    } else {
      ignored.push("date");
    }
  }

  // Whatever is left describes the picture itself and goes to CLIP unchanged.
  const visual =
    typeof raw.visual === "string" ? raw.visual.trim().slice(0, MAX_VISUAL_LENGTH) : "";

  // Nothing structured came back: the "interpretation" is just the original
  // query, so say so and let the plain search stand rather than re-rendering the
  // same results behind an AI badge.
  if (chips.length === 0) {
    return { interpreted: false, reason: "no-filters" };
  }

  filter.semanticQuery = visual || undefined;
  if (visual) chips.push({ field: "semanticQuery", label: `“${visual}”` });

  log.info(
    { query: trimmedQuery, chips: chips.length, ignored: ignored.length },
    "query interpreted",
  );

  return { interpreted: true, query: trimmedQuery, filter, chips, ignored };
};
