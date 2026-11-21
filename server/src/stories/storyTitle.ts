import type { StoryItem, StoryKind, StoryPerson } from "./storyTypes.ts";

type Place = { city: string; region: string; country: string };

/** Splits `files.placeText`: US rows carry a state, the rest go straight to the country. */
export const parsePlace = (text: string | null): Place | null => {
  const parts = (text ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 4 && parts[3] === "USA")
    return { city: parts[0], region: parts[1], country: parts[2] };
  const country = parts.at(-1)!;
  return { city: parts[0], region: country, country };
};

/** Distinct names, most frequent first; `order` is where each first appears, for telling them in sequence. */
const ranked = (names: string[]) => {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts]
    .map(([name, count], order) => ({ name, share: count / names.length, order }))
    .sort((a, b) => b.share - a.share);
};

const inVisitOrder = (names: Array<{ name: string; order: number }>) =>
  [...names].sort((a, b) => a.order - b.order).map(({ name }) => name);

const joinNames = (names: string[]) =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} & ${names.at(-1)}`;

/**
 * Names a set of places (in time order) at the finest level where at most a
 * few names cover 85% of them: one or two cities, else up to three states
 * (countries abroad), else up to three countries. Named in the order visited.
 */
export const placeTitle = (places: Place[]): string | null => {
  if (places.length === 0) return null;
  for (const level of ["city", "region", "country"] as const) {
    const top = ranked(places.map((place) => place[level]));
    const maxNames = level === "city" ? 2 : 3;
    for (let count = 1; count <= Math.min(maxNames, top.length); count++) {
      const covered = top.slice(0, count).reduce((sum, { share }) => sum + share, 0);
      if (covered >= 0.85) return joinNames(inVisitOrder(top.slice(0, count)));
    }
  }
  return joinNames(
    inVisitOrder(ranked(places.map(({ country }) => country)).slice(0, 3)),
  );
};

/** Folder names that say nothing about what is in them. */
const GENERIC_FOLDER =
  /^(\d{1,4}([-_. ]\d{1,2}){0,2}|\d{3}[a-z_]{4,5}|dcim|camera( roll)?|pictures|photos|images|img|uploads?|mobile|misc|screenshots|whatsapp.*|import.*|backup.*|export.*|new folder.*)$/i;

/** The leaf folder most of the items share, if it reads like a name ("2019-07-04 Fourth of July" -> "Fourth of July"). */
export const folderTitle = (items: StoryItem[]): string | null => {
  const leaves = items.map(({ path }) => path.split("/").at(-2) ?? "");
  const [top] = ranked(leaves);
  if (!top || top.share < 0.6) return null;
  const name = top.name
    .replace(/^\d{4}([-_. ]\d{1,2}){0,2}[-_. ]+/, "")
    .replace(/[_]+/g, " ")
    .trim();
  return name && !GENERIC_FOLDER.test(name) ? name : null;
};

const KICKERS: Record<StoryKind, string> = {
  trip: "Trip",
  weekend: "Weekend away",
  dayTrip: "Day trip",
  event: "A big day",
};

const longDate = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });

/** A story's kicker, title and its places, most-photographed first. */
export const storyTitle = (
  kind: StoryKind,
  startDay: string,
  items: StoryItem[],
  people: StoryPerson[],
) => {
  const parsed = items.flatMap(({ place }) => parsePlace(place) ?? []);
  const places = ranked(parsed.map(({ city }) => city))
    .slice(0, 5)
    .map(({ name }) => name);
  const fromPeople = people.length
    ? `With ${joinNames(people.slice(0, 2).map(({ name }) => name))}`
    : null;
  const title =
    (kind === "event"
      ? folderTitle(items)
      : (placeTitle(parsed) ?? folderTitle(items))) ??
    fromPeople ??
    longDate(startDay);
  return { kicker: KICKERS[kind], title, places };
};
