import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { getLogger } from "../observability/logger.ts";

const log = getLogger("searchVocabulary");

/**
 * A person the query is allowed to name.
 *
 * `clusterId` is set for People-tab face clusters the user has named — matching
 * one filters by recognized face, which is far more reliable than the
 * `personInImage` metadata tag. Entries without it come from that metadata and
 * filter by tag instead.
 */
export type VocabularyPerson = {
  name: string;
  /** People-tab cluster id in `person-<n>` form, when this name is a face cluster. */
  clusterId?: string;
};

export type SearchVocabulary = {
  people: VocabularyPerson[];
  /**
   * Folder names, most populated first — a bare top-level name ("Trips") or
   * a one-level-deep relative path ("Trips/Beach Trip 2024"), see
   * `loadFolders`. Either form is a valid `path` filter value as-is, so
   * `interpretSearchQuery`'s matching/assignment needs no change for the
   * nested case.
   */
  folders: string[];
};

// Prompt-size caps. The whole vocabulary is inlined into every interpretation
// prompt, so it stays small enough to keep the 3B model's attention (and the
// request fast) rather than exhaustive.
const MAX_PEOPLE = 40;
const MAX_FOLDERS = 60;
// How many of the most-populated top-level folders to look inside for a
// second level of vocabulary. Bounded because each one is its own SQL round
// trip (see loadFolders) — most libraries' real "the thing someone would
// name in a search" folders (an event, a trip) sit one level under a handful
// of big top-level categories ("Trips", "Family Archive"), not scattered
// under all of them, so this doesn't need to be large to cover the common case.
const MAX_TOP_FOLDERS_TO_EXPAND = 15;

// The library's people and folders change on a human timescale; re-querying them
// per search would add two SQL round-trips to the interactive path for nothing.
const CACHE_TTL_MS = 5 * 60 * 1000;

let cache: { value: SearchVocabulary; at: number } | undefined;
let inflight: Promise<SearchVocabulary> | undefined;

/** Test seam: drops the memoized vocabulary. */
export const clearSearchVocabularyCache = () => {
  cache = undefined;
  inflight = undefined;
};

const loadPeople = async (database: IndexDatabase): Promise<VocabularyPerson[]> => {
  const people: VocabularyPerson[] = [];
  const seen = new Set<string>();

  // Named face clusters first: a name the user has actually assigned in the
  // People tab is the strongest signal, and gives an exact cluster filter.
  try {
    const rows = await database.asyncSqlite.all<{ id: number; name: string | null }>(
      `SELECT id, name FROM faceClusters
        WHERE name IS NOT NULL AND TRIM(name) != ''
        ORDER BY weight DESC
        LIMIT ?`,
      MAX_PEOPLE,
    );
    for (const row of rows) {
      const name = row.name?.trim();
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      people.push({ name, clusterId: `person-${row.id}` });
    }
  } catch (error) {
    // A library with face clustering disabled has no such table/rows; the
    // metadata names below still ground the prompt.
    log.debug({ err: error }, "no named face clusters available");
  }

  if (people.length < MAX_PEOPLE) {
    try {
      const tagged = await database.queryFieldSuggestions({
        field: "personInImage",
        search: "",
        filter: {},
        limit: MAX_PEOPLE,
      });
      for (const name of tagged) {
        const trimmed = name.trim();
        if (!trimmed || seen.has(trimmed.toLowerCase())) continue;
        if (people.length >= MAX_PEOPLE) break;
        seen.add(trimmed.toLowerCase());
        people.push({ name: trimmed });
      }
    } catch (error) {
      log.debug({ err: error }, "no personInImage tags available");
    }
  }

  return people;
};

/**
 * Feedback #111: "Beach trip 2024" should match a real folder even when it's
 * nested ("Trips/Beach trip 2024"), not just a top-level one — previously
 * only top-level names were ever offered to the model, so any query naming
 * an actual album/event folder one level down silently missed the folder
 * filter entirely and fell back to date+visual matching alone. Expands the
 * most-populated top-level folders one level deeper and represents each
 * nested entry as its `Parent/Child` relative path, which is already a
 * valid `path` filter value on its own — no change needed to how a match
 * gets turned into a filter.
 */
const loadFolders = async (database: IndexDatabase): Promise<string[]> => {
  try {
    const topLevel = await database.getFolders("/", {});
    const ranked = [...topLevel].sort((a, b) => b.count - a.count);

    const nestedEntries = await Promise.all(
      ranked.slice(0, MAX_TOP_FOLDERS_TO_EXPAND).map(async (parent) => {
        try {
          const children = await database.getFolders(`/${parent.name}/`, {});
          return children.map((child) => ({
            name: `${parent.name}/${child.name}`,
            count: child.count,
          }));
        } catch (error) {
          log.debug({ err: error, folder: parent.name }, "nested folder listing unavailable");
          return [];
        }
      }),
    );

    return [...ranked, ...nestedEntries.flat()]
      .sort((a, b) => b.count - a.count)
      .slice(0, MAX_FOLDERS)
      .map(({ name }) => name);
  } catch (error) {
    log.debug({ err: error }, "folder listing unavailable");
    return [];
  }
};

/**
 * The candidate lists the model is grounded in: the only people and folders it
 * may name. Anything else it produces is rejected by the interpreter, so a
 * hallucinated "Sarah" can never turn into a filter that silently matches zero
 * photos.
 *
 * Cached briefly and de-duplicated across concurrent searches.
 */
export const loadSearchVocabulary = async (
  database: IndexDatabase,
  now = Date.now(),
): Promise<SearchVocabulary> => {
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;
  if (inflight) return inflight;

  inflight = (async () => {
    const [people, folders] = await Promise.all([
      loadPeople(database),
      loadFolders(database),
    ]);
    const value = { people, folders };
    cache = { value, at: Date.now() };
    return value;
  })().finally(() => {
    inflight = undefined;
  });

  return inflight;
};
