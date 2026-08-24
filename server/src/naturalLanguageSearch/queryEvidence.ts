/**
 * Deterministic checks of what the *user's own words* support.
 *
 * Grounding the model in the library's vocabulary stops it inventing a person
 * who does not exist; it does not stop it picking a person who does exist but
 * was never asked for. Measured against the live 3B model, that is the common
 * failure: "videos from the Portland trip with the kids" came back with
 * `people: ["Ben", "Aunt May"]` and `folder: "Trips"`, and "photos of Sarah at
 * the beach last summer" came back with an invented `2018-2019` date range.
 * Every one of those would have silently emptied the result grid.
 *
 * So a proposed filter must also be *evidenced by the query text*: the name has
 * to appear in it, the media type needs a word like "videos", a date needs a
 * temporal phrase. Dates go further — the phrase is parsed here rather than
 * taken from the model at all, because a small model reliably mangles them.
 */

import {
  resolveDateIntent,
  type DateIntent,
  type Holiday,
  type Season,
} from "./resolveDateIntent.ts";

const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter(Boolean);

const normalize = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Drop a plural "s" so "trip" and "Trips" match; short words are left alone. */
const singular = (word: string) =>
  word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word;

/** A query token matches a vocabulary word, tolerating plurals/possessives. */
const tokenMatches = (token: string, word: string) =>
  singular(token.replace(/'s$/, "")) === singular(word);

/**
 * Did the user actually name this person/place?
 *
 * Multi-word folder/place entries ("Family Archive") need every significant
 * word present, so "family photos" does not select the "Family Archive"
 * folder. Person names are looser (`matchAnyWord: true`): full names in the
 * library routinely carry a middle or maiden name ("Sarah Johnson Richards")
 * that nobody types when searching, so a query only needs to hit one
 * significant word of the name, not all of them.
 */
export const queryMentions = (
  query: string,
  value: string,
  { matchAnyWord = false }: { matchAnyWord?: boolean } = {},
): boolean => {
  const words = tokenize(value);
  if (words.length === 0) return false;
  const tokens = tokenize(query);
  if (words.length === 1) {
    return tokens.some((token) => tokenMatches(token, words[0]));
  }
  if (normalize(query).includes(normalize(value))) return true;
  const significantWords = words.filter((word) => word.length >= 4);
  const matches = (word: string) => tokens.some((token) => tokenMatches(token, word));
  return matchAnyWord ? significantWords.some(matches) : significantWords.every(matches);
};

const PHOTO_WORDS = [
  "photo",
  "photos",
  "photograph",
  "photographs",
  "picture",
  "pictures",
  "pic",
  "pics",
  "image",
  "images",
  "shot",
  "shots",
  "snapshot",
  "snapshots",
  "stills",
];
const VIDEO_WORDS = [
  "video",
  "videos",
  "clip",
  "clips",
  "movie",
  "movies",
  "footage",
  "recording",
  "recordings",
  "film",
  "films",
];

/** The media type the query itself asks for, if any. */
export const mediaTypeEvidence = (query: string): "photo" | "video" | null => {
  const tokens = new Set(tokenize(query));
  const video = VIDEO_WORDS.some((word) => tokens.has(word));
  const photo = PHOTO_WORDS.some((word) => tokens.has(word));
  // "photos and videos" constrains nothing.
  if (video && photo) return null;
  if (video) return "video";
  if (photo) return "photo";
  return null;
};

const RATING_WORDS = [
  "star",
  "stars",
  "starred",
  "best",
  "favorite",
  "favorites",
  "favourite",
  "favourites",
  "top",
  "rated",
  "rating",
];

/** Does the query ask for quality at all? */
export const ratingEvidence = (query: string): boolean => {
  const tokens = new Set(tokenize(query));
  return RATING_WORDS.some((word) => tokens.has(word));
};

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

const SEASON_WORDS: Record<string, Season> = {
  spring: "spring",
  springs: "spring",
  summer: "summer",
  summers: "summer",
  fall: "fall",
  falls: "fall",
  autumn: "fall",
  autumns: "fall",
  winter: "winter",
  winters: "winter",
};

const HOLIDAY_WORDS: Record<string, Holiday> = {
  christmas: "christmas",
  christmases: "christmas",
  xmas: "christmas",
  thanksgiving: "thanksgiving",
  thanksgivings: "thanksgiving",
  halloween: "halloween",
  halloweens: "halloween",
  easter: "easter",
  easters: "easter",
  newyear: "newyear",
  newyears: "newyear",
  hogmanay: "newyear",
};

const MONTH_WORDS: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

const RECENT_UNIT_WORDS: Record<string, "day" | "week" | "month" | "year"> = {
  day: "day",
  days: "day",
  week: "week",
  weeks: "week",
  month: "month",
  months: "month",
  year: "year",
  years: "year",
};

// Deliberately narrow: vague words ("this", "back", "when") are not evidence of
// a date, and letting them through is what lets an invented range slip in.
const TEMPORAL_HINTS = new Set([
  "last",
  "past",
  "recent",
  "recently",
  "ago",
  "yesterday",
  "today",
  "latest",
  "since",
]);

/**
 * Is there anything time-related in the query at all? Used to reject a date the
 * model produced out of thin air for a query like "sunset over water".
 */
export const hasTemporalEvidence = (query: string): boolean => {
  const tokens = tokenize(query);
  return tokens.some(
    (token) =>
      TEMPORAL_HINTS.has(token) ||
      token in SEASON_WORDS ||
      token in HOLIDAY_WORDS ||
      token in MONTH_WORDS ||
      token in RECENT_UNIT_WORDS ||
      /^(19|20)\d{2}$/.test(token),
  );
};

/** Every 4-digit year the query literally spells out. */
export const yearsInQuery = (query: string): number[] =>
  tokenize(query)
    .filter((token) => /^(19|20)\d{2}$/.test(token))
    .map(Number);

/**
 * How many occurrences back the words around a period point to.
 *
 * "two Christmases ago" is a count. "last summer" is not: it means the most
 * recent *completed* occurrence, which depends on the date — in July, last
 * summer is a year ago because this one is still running, but last Christmas is
 * the one just gone. Asking the resolver for the current occurrence and seeing
 * whether it has finished keeps that rule in one place.
 */
const yearsAgoFromContext = (
  tokens: string[],
  index: number,
  base: DateIntent,
  now: number,
): number => {
  const following = tokens[index + 1];
  const preceding = tokens[index - 1];
  const twoBefore = tokens[index - 2];

  if (following === "ago") {
    const count = preceding ? (NUMBER_WORDS[preceding] ?? Number(preceding)) : NaN;
    if (Number.isInteger(count) && count > 0) return count;
    return 1;
  }
  if (preceding === "last" || preceding === "past" || twoBefore === "last") {
    const current = resolveDateIntent({ ...base, yearsAgo: 0 }, now);
    return current && current.end > now ? 1 : 0;
  }
  return 0;
};

/**
 * Parse the query's own date phrasing.
 *
 * Preferred over whatever the model said, because it is derived from the text
 * the user typed instead of from a 3B model's arithmetic. Returns `null` when
 * the query has no date phrasing this understands, leaving the (gated) model
 * answer as the fallback.
 */
export const extractDateIntent = (query: string, now: number): DateIntent | null => {
  const tokens = tokenize(query);
  const currentYear = new Date(now).getUTCFullYear();

  // "2015 to 2018" / "between 2015 and 2018"
  const years = yearsInQuery(query);
  const monthIndex = tokens.findIndex((token) => token in MONTH_WORDS);

  if (years.length >= 2) {
    return { kind: "yearRange", startYear: years[0], endYear: years[1] };
  }
  if (years.length === 1) {
    // "July 2019" is a month, a bare "2019" is the whole year.
    if (monthIndex !== -1) {
      return { kind: "month", month: MONTH_WORDS[tokens[monthIndex]], year: years[0] };
    }
    return { kind: "year", year: years[0] };
  }

  const seasonIndex = tokens.findIndex((token) => token in SEASON_WORDS);
  if (seasonIndex !== -1) {
    const base: DateIntent = {
      kind: "season",
      season: SEASON_WORDS[tokens[seasonIndex]],
    };
    return { ...base, yearsAgo: yearsAgoFromContext(tokens, seasonIndex, base, now) };
  }

  // "new year" / "new years" is two tokens; fold it before the single-word scan.
  const newYearIndex = tokens.findIndex(
    (token, index) => token === "new" && /^years?$/.test(tokens[index + 1] ?? ""),
  );
  if (newYearIndex !== -1) {
    const base: DateIntent = { kind: "holiday", holiday: "newyear" };
    // Anchor on "new", so "last new year" reads its modifier from the right word.
    return { ...base, yearsAgo: yearsAgoFromContext(tokens, newYearIndex, base, now) };
  }

  const holidayIndex = tokens.findIndex((token) => token in HOLIDAY_WORDS);
  if (holidayIndex !== -1) {
    const base: DateIntent = {
      kind: "holiday",
      holiday: HOLIDAY_WORDS[tokens[holidayIndex]],
    };
    return { ...base, yearsAgo: yearsAgoFromContext(tokens, holidayIndex, base, now) };
  }

  if (monthIndex !== -1) {
    const base: DateIntent = { kind: "month", month: MONTH_WORDS[tokens[monthIndex]] };
    return { ...base, yearsAgo: yearsAgoFromContext(tokens, monthIndex, base, now) };
  }

  // "last 30 days", "past two weeks", "3 months ago", "last year".
  const unitIndex = tokens.findIndex((token) => token in RECENT_UNIT_WORDS);
  if (unitIndex !== -1) {
    const unit = RECENT_UNIT_WORDS[tokens[unitIndex]];
    const preceding = tokens[unitIndex - 1];
    const count = preceding ? (NUMBER_WORDS[preceding] ?? Number(preceding)) : NaN;
    const hasCount = Number.isInteger(count) && count > 0;
    const relative =
      preceding === "last" ||
      preceding === "past" ||
      preceding === "this" ||
      tokens[unitIndex - 2] === "last" ||
      tokens[unitIndex - 2] === "past";
    if (!hasCount && !relative) return null;

    // A bare "last year"/"last month" means that whole calendar period, which is
    // what a photo library user means — not a rolling window ending today.
    if (!hasCount && unit === "year") {
      return { kind: "year", year: preceding === "this" ? currentYear : currentYear - 1 };
    }
    return { kind: "recent", unit, n: hasCount ? count : 1 };
  }

  return null;
};
