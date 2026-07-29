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
  /** Top-level folder names, most populated first. */
  folders: string[];
};

// Prompt-size caps. The whole vocabulary is inlined into every interpretation
// prompt, so it stays small enough to keep the 3B model's attention (and the
// request fast) rather than exhaustive.
const MAX_PEOPLE = 40;
const MAX_FOLDERS = 40;

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

const loadFolders = async (database: IndexDatabase): Promise<string[]> => {
  try {
    const folders = await database.getFolders("/", {});
    return folders
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
