import { haversineKm, median } from "./geo.ts";
import type { StoryItem, StoryKind, StorySpan } from "./storyTypes.ts";

const DAY_MS = 86_400_000;

export type DetectOptions = {
  /** A day whose photos sit (median) farther than this from home is "away". */
  awayKm: number;
  /** Size of the grid cell that finds home: the cell with the most distinct days. */
  homeCellDegrees: number;
  /** A year needs this many days in one cell to have a home of its own; else the all-time home stands. */
  minHomeDays: number;
  /** Days with no photos at all that a trip may span without ending. */
  maxGapDays: number;
  /** Longer than this away is a move or a season abroad, not a story. */
  maxTripDays: number;
  minTripPhotos: number;
  /** A day at home with at least this many items is an event. */
  minEventPhotos: number;
};

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));

/**
 * Thresholds scaled to the library: a small library gets stories from a
 * handful of photos, a large one only from runs that stand out from an
 * ordinary day.
 */
export const defaultDetectOptions = (items: StoryItem[]): DetectOptions => {
  const perDay = new Map<number, number>();
  for (const { time } of items)
    perDay.set(dayNumber(time), (perDay.get(dayNumber(time)) ?? 0) + 1);
  const typicalDay = perDay.size ? median([...perDay.values()]) : 0;
  return {
    awayKm: 80,
    homeCellDegrees: 0.5,
    minHomeDays: 5,
    maxGapDays: 2,
    maxTripDays: 45,
    minTripPhotos: clamp(Math.round(items.length / 4000), 4, 12),
    minEventPhotos: Math.max(
      clamp(Math.round(items.length / 1500), 8, 40),
      Math.ceil(typicalDay * 4),
    ),
  };
};

/** The local calendar day of a time, as a day count since the epoch. */
export const dayNumber = (time: number) => {
  const date = new Date(time);
  return Math.round(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS,
  );
};

export const dayKey = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);

type Point = { lat: number; lon: number };
type Cell = { days: Set<number>; lats: number[]; lons: number[] };

/**
 * Where home was, per year: the grid cell with the most distinct days of
 * geotagged photos. Per year so a move doesn't turn the new town into one
 * long trip; a sparse year falls back to the all-time home.
 */
const findHomes = (items: StoryItem[], options: DetectOptions) => {
  const byYear = new Map<number, Map<string, Cell>>();
  const overall = new Map<string, Cell>();
  for (const { lat, lon, time } of items) {
    if (lat === null || lon === null) continue;
    const key = `${Math.floor(lat / options.homeCellDegrees)},${Math.floor(lon / options.homeCellDegrees)}`;
    const year = new Date(time).getFullYear();
    if (!byYear.has(year)) byYear.set(year, new Map());
    for (const cells of [byYear.get(year)!, overall]) {
      const cell = cells.get(key) ?? { days: new Set(), lats: [], lons: [] };
      cell.days.add(dayNumber(time));
      cell.lats.push(lat);
      cell.lons.push(lon);
      cells.set(key, cell);
    }
  }
  const top = (cells: Map<string, Cell> | undefined, minDays: number): Point | null => {
    let best: Cell | null = null;
    for (const cell of cells?.values() ?? []) {
      if (
        !best ||
        cell.days.size > best.days.size ||
        (cell.days.size === best.days.size && cell.lats.length > best.lats.length)
      )
        best = cell;
    }
    return best && best.days.size >= minDays
      ? { lat: median(best.lats), lon: median(best.lons) }
      : null;
  };
  const allTime = top(overall, 2);
  const yearly = new Map(
    [...byYear].map(([year, cells]) => [
      year,
      top(cells, options.minHomeDays) ?? allTime,
    ]),
  );
  return (time: number) => yearly.get(new Date(time).getFullYear()) ?? allTime;
};

type Day = { day: number; items: StoryItem[]; status: "home" | "away" | "unknown" };

const kindOf = (days: Day[]): StoryKind => {
  const span = days.at(-1)!.day - days[0].day + 1;
  if (span === 1) return "dayTrip";
  // Day numbers count from Thursday 1970-01-01, so day % 7 of 2 is Saturday and 3 Sunday.
  if (span <= 3 && days.some(({ day }) => [2, 3].includes(((day % 7) + 7) % 7)))
    return "weekend";
  return "trip";
};

const toSpan = (kind: StoryKind, days: Day[]): StorySpan => {
  const startDay = dayKey(days[0].day);
  const endDay = dayKey(days.at(-1)!.day);
  return {
    id: `${kind === "event" ? "event" : "trip"}-${startDay}-${endDay}`,
    kind,
    startDay,
    endDay,
    dayCount: days.at(-1)!.day - days[0].day + 1,
    items: days.flatMap((day) => day.items),
  };
};

/**
 * Finds the stories in a library: trips (runs of days away from home) and
 * events (days at home with far more photos than usual). Newest first.
 *
 * A trip starts on an away day and runs while the following days are away or
 * have no GPS, ending at a home day or a gap longer than maxGapDays. Days
 * without GPS only count when another away day follows, so a camera without
 * GPS on the drive home doesn't stretch the trip.
 */
export const detectStories = (
  items: StoryItem[],
  options: DetectOptions,
): StorySpan[] => {
  const homeAt = findHomes(items, options);
  const byDay = new Map<number, StoryItem[]>();
  for (const item of [...items].sort((a, b) => a.time - b.time)) {
    const day = dayNumber(item.time);
    const list = byDay.get(day);
    if (list) list.push(item);
    else byDay.set(day, [item]);
  }
  const days: Day[] = [...byDay].map(([day, dayItems]) => {
    const home = homeAt(dayItems[0].time);
    const distances = dayItems.flatMap(({ lat, lon }) =>
      home && lat !== null && lon !== null
        ? [haversineKm(home.lat, home.lon, lat, lon)]
        : [],
    );
    const status =
      distances.length === 0
        ? "unknown"
        : median(distances) > options.awayKm
          ? "away"
          : "home";
    return { day, items: dayItems, status };
  });

  const stories: StorySpan[] = [];
  const inTrip = new Set<number>();
  for (let start = 0; start < days.length; start++) {
    if (days[start].status !== "away") continue;
    let end = start;
    for (let next = start + 1; next < days.length; next++) {
      if (
        days[next].day - days[next - 1].day - 1 > options.maxGapDays ||
        days[next].status === "home"
      )
        break;
      if (days[next].status === "away") end = next;
    }
    const tripDays = days.slice(start, end + 1);
    const photoCount = tripDays.reduce((sum, day) => sum + day.items.length, 0);
    const span = tripDays.at(-1)!.day - tripDays[0].day + 1;
    if (photoCount >= options.minTripPhotos && span <= options.maxTripDays) {
      stories.push(toSpan(kindOf(tripDays), tripDays));
      for (const day of tripDays) inTrip.add(day.day);
    }
    start = end;
  }

  let run: Day[] = [];
  const flush = () => {
    if (run.length) stories.push(toSpan("event", run));
    run = [];
  };
  for (const day of days) {
    if (inTrip.has(day.day) || day.items.length < options.minEventPhotos) continue;
    if (run.length && day.day - run.at(-1)!.day > 1) flush();
    run.push(day);
  }
  flush();

  return stories.sort((a, b) => b.startDay.localeCompare(a.startDay));
};
