import { prepareCentroids, type NamedCentroid, type PreparedCentroid } from "./identifyFaces.ts";

/**
 * How long the named-centroid snapshot is reused before it is re-read.
 *
 * Naming a person in the People tab is a rare, human-paced event, while the
 * identify endpoint can be hit several times per doorbell visit — so a short
 * TTL cache keeps a burst from re-reading and re-normalizing every centroid,
 * and the worst case is that a person named seconds ago goes unrecognized for
 * one minute. Renames drop the cache outright (see peopleRequestHandler).
 */
const CENTROID_CACHE_TTL_MS = 60_000;

let centroidCache: { at: number; centroids: PreparedCentroid[] } | null = null;
let centroidLoad: Promise<PreparedCentroid[]> | null = null;

/** Drops the cache after a rename/merge so a new name takes effect immediately. */
export const invalidateNamedCentroidCache = (): void => {
  centroidCache = null;
};

/** Named people's centroids, ready to score against, re-read at most once a minute. */
export const getNamedCentroids = async (
  loadNamedCentroids: () => Promise<NamedCentroid[]>,
): Promise<PreparedCentroid[]> => {
  const now = Date.now();
  if (centroidCache && now - centroidCache.at < CENTROID_CACHE_TTL_MS) {
    return centroidCache.centroids;
  }
  // Memoized so a burst arriving on a cold cache reads the table once.
  if (!centroidLoad) {
    centroidLoad = loadNamedCentroids()
      .then((rows) => {
        const centroids = prepareCentroids(rows);
        centroidCache = { at: Date.now(), centroids };
        return centroids;
      })
      .finally(() => {
        centroidLoad = null;
      });
  }
  return centroidLoad;
};
