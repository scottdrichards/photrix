/**
 * Deterministic resolution of the *relative* date intents a language model is
 * allowed to emit ("last summer", "two Christmases ago") into a concrete
 * millisecond range.
 *
 * The model never computes a date. It only names the kind of period and how many
 * years back it is; every boundary below is arithmetic on the request's own
 * clock, so the same query asked in December and in June resolves correctly and
 * the result is reproducible in tests by passing `now`.
 *
 * All boundaries are UTC, matching how `dateTaken` is stored and how the rest of
 * the app formats capture dates.
 */

export const SEASONS = ["spring", "summer", "fall", "winter"] as const;
export type Season = (typeof SEASONS)[number];

export const HOLIDAYS = [
  "christmas",
  "newyear",
  "thanksgiving",
  "halloween",
  "easter",
] as const;
export type Holiday = (typeof HOLIDAYS)[number];

export const RECENT_UNITS = ["day", "week", "month", "year"] as const;
export type RecentUnit = (typeof RECENT_UNITS)[number];

export type DateIntent =
  | { kind: "year"; year: number }
  | { kind: "yearRange"; startYear: number; endYear: number }
  | { kind: "season"; season: Season; yearsAgo?: number }
  | { kind: "month"; month: number; year?: number; yearsAgo?: number }
  | { kind: "holiday"; holiday: Holiday; yearsAgo?: number }
  | { kind: "recent"; unit: RecentUnit; n: number };

export type ResolvedDateRange = {
  start: number;
  end: number;
  /** Human label for the filter chip, e.g. "Summer 2025". */
  label: string;
};

/** Oldest year worth accepting — photography predates it, digital libraries do not. */
const MIN_YEAR = 1826;

const DAY_MS = 24 * 60 * 60 * 1000;

const startOfDay = (year: number, month: number, day: number) =>
  Date.UTC(year, month, day);
/** Inclusive end-of-day: the last millisecond, so ranges are closed intervals. */
const endOfDay = (year: number, month: number, day: number) =>
  Date.UTC(year, month, day + 1) - 1;

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const SEASON_LABEL: Record<Season, string> = {
  spring: "Spring",
  summer: "Summer",
  fall: "Fall",
  winter: "Winter",
};

const HOLIDAY_LABEL: Record<Holiday, string> = {
  christmas: "Christmas",
  newyear: "New Year",
  thanksgiving: "Thanksgiving",
  halloween: "Halloween",
  easter: "Easter",
};

/** Meteorological seasons (northern hemisphere), keyed by the year they *end* in. */
const seasonWindow = (season: Season, year: number): { start: number; end: number } => {
  switch (season) {
    case "spring":
      return { start: startOfDay(year, 2, 1), end: endOfDay(year, 4, 31) };
    case "summer":
      return { start: startOfDay(year, 5, 1), end: endOfDay(year, 7, 31) };
    case "fall":
      return { start: startOfDay(year, 8, 1), end: endOfDay(year, 10, 30) };
    case "winter":
      // Winter <year> spans December of the previous year into February; ending
      // at "March 1 minus 1ms" is leap-year safe.
      return { start: startOfDay(year - 1, 11, 1), end: startOfDay(year, 2, 1) - 1 };
  }
};

/** Fourth Thursday of November. */
const thanksgivingDay = (year: number): number => {
  const firstOfNovember = new Date(Date.UTC(year, 10, 1));
  const offsetToThursday = (4 - firstOfNovember.getUTCDay() + 7) % 7;
  return 1 + offsetToThursday + 21;
};

/** Anonymous Gregorian computus — Easter Sunday for a given year. */
const easterSunday = (year: number): { month: number; day: number } => {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3 = March, 4 = April
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month: month - 1, day };
};

/**
 * Holidays are windows, not days: people search "Christmas" meaning the few days
 * around it, and a photo of the tree on the 27th should still match.
 */
const holidayWindow = (
  holiday: Holiday,
  year: number,
): { start: number; end: number } => {
  switch (holiday) {
    case "christmas":
      return { start: startOfDay(year, 11, 20), end: endOfDay(year, 11, 27) };
    case "newyear":
      return { start: startOfDay(year - 1, 11, 31), end: endOfDay(year, 0, 1) };
    case "thanksgiving": {
      const day = thanksgivingDay(year);
      return { start: startOfDay(year, 10, day - 1), end: endOfDay(year, 10, day + 3) };
    }
    case "halloween":
      return { start: startOfDay(year, 9, 30), end: endOfDay(year, 10, 1) };
    case "easter": {
      const { month, day } = easterSunday(year);
      return {
        start: startOfDay(year, month, day - 2),
        end: endOfDay(year, month, day + 1),
      };
    }
  }
};

const isInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value);

const clampYearsAgo = (value: unknown): number | null => {
  if (value === undefined || value === null) return 0;
  if (!isInteger(value) || value < 0 || value > 200) return null;
  return value;
};

const validYear = (year: unknown, now: number): year is number =>
  isInteger(year) && year >= MIN_YEAR && year <= new Date(now).getUTCFullYear() + 1;

/**
 * Anchor a recurring period (season/month/holiday) to a calendar year.
 *
 * `yearsAgo` counts calendar occurrences back from the current one: 0 is "this",
 * 1 is "last". The one correction: when the current year's occurrence has not
 * started yet, "this summer" in February means the *coming* summer, which holds
 * no photos — so it falls back a year to the most recent one that exists.
 */
const anchorYear = (
  yearsAgo: number,
  now: number,
  windowFor: (year: number) => { start: number },
): number => {
  const currentYear = new Date(now).getUTCFullYear();
  const candidate = currentYear - yearsAgo;
  if (yearsAgo === 0 && windowFor(candidate).start > now) return candidate - 1;
  return candidate;
};

const RECENT_UNIT_MS: Record<RecentUnit, number> = {
  day: DAY_MS,
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
  year: 365 * DAY_MS,
};

const recentLabel = (unit: RecentUnit, n: number) =>
  n === 1 ? `Last ${unit}` : `Last ${n} ${unit}s`;

/**
 * Turn a model-supplied date intent into a concrete range, or `null` when the
 * intent is malformed. Callers drop the date facet on `null` rather than
 * guessing — a wrong date range silently empties the result grid.
 */
export const resolveDateIntent = (
  intent: unknown,
  now: number,
): ResolvedDateRange | null => {
  if (typeof intent !== "object" || intent === null) return null;
  const value = intent as Record<string, unknown>;

  switch (value.kind) {
    case "year": {
      if (!validYear(value.year, now)) return null;
      const year = value.year;
      return {
        start: startOfDay(year, 0, 1),
        end: endOfDay(year, 11, 31),
        label: String(year),
      };
    }

    case "yearRange": {
      if (!validYear(value.startYear, now) || !validYear(value.endYear, now)) return null;
      const startYear = Math.min(value.startYear, value.endYear);
      const endYear = Math.max(value.startYear, value.endYear);
      return {
        start: startOfDay(startYear, 0, 1),
        end: endOfDay(endYear, 11, 31),
        label: startYear === endYear ? String(startYear) : `${startYear}–${endYear}`,
      };
    }

    case "season": {
      const season = value.season;
      if (!(SEASONS as readonly unknown[]).includes(season)) return null;
      const yearsAgo = clampYearsAgo(value.yearsAgo);
      if (yearsAgo === null) return null;
      const year = anchorYear(yearsAgo, now, (candidate) =>
        seasonWindow(season as Season, candidate),
      );
      const window = seasonWindow(season as Season, year);
      return { ...window, label: `${SEASON_LABEL[season as Season]} ${year}` };
    }

    case "month": {
      const month = value.month;
      if (!isInteger(month) || month < 1 || month > 12) return null;
      const monthIndex = month - 1;
      let year: number;
      if (value.year !== undefined && value.year !== null) {
        if (!validYear(value.year, now)) return null;
        year = value.year;
      } else {
        const yearsAgo = clampYearsAgo(value.yearsAgo);
        if (yearsAgo === null) return null;
        year = anchorYear(yearsAgo, now, (candidate) => ({
          start: startOfDay(candidate, monthIndex, 1),
        }));
      }
      return {
        start: startOfDay(year, monthIndex, 1),
        end: startOfDay(year, monthIndex + 1, 1) - 1,
        label: `${MONTH_NAMES[monthIndex]} ${year}`,
      };
    }

    case "holiday": {
      const holiday = value.holiday;
      if (!(HOLIDAYS as readonly unknown[]).includes(holiday)) return null;
      const yearsAgo = clampYearsAgo(value.yearsAgo);
      if (yearsAgo === null) return null;
      const year = anchorYear(yearsAgo, now, (candidate) =>
        holidayWindow(holiday as Holiday, candidate),
      );
      const window = holidayWindow(holiday as Holiday, year);
      return { ...window, label: `${HOLIDAY_LABEL[holiday as Holiday]} ${year}` };
    }

    case "recent": {
      const unit = value.unit;
      if (!(RECENT_UNITS as readonly unknown[]).includes(unit)) return null;
      const n = value.n;
      if (!isInteger(n) || n < 1 || n > 100) return null;
      return {
        start: now - RECENT_UNIT_MS[unit as RecentUnit] * n,
        end: now,
        label: recentLabel(unit as RecentUnit, n),
      };
    }

    default:
      return null;
  }
};
