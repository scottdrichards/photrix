import {
  buildFaceClustersPCAResult,
  dotFaceClusterVectors,
  formatYearRangeLabel,
  normalizeFaceClusterCentroid,
  type FaceClusterPCASeed,
} from "../clustering/clusterLayout.ts";
import { AsyncSqlite } from "../../common/asyncSqlite.ts";
import { runWithoutRequestAbortSignal } from "../../common/requestAbort.ts";
import { filterToSQL } from "../../indexDatabase/filterToSQL.ts";
import { type FaceClusterFace, type FaceClusterSummary, type FaceClusterPCAResult, type QueryOptions } from "../../indexDatabase/indexDatabase.type.ts";
import { toAlignedFloat32 } from "../../common/toAlignedFloat32.ts";
import { faceClusterIdToString } from "./faceClusterId.ts";
import { faceRowToClusterFace } from "./faceRowToClusterFace.ts";

// At a real library's scale (~316k faces) the greedy clustering produces a
// huge tail of tiny clusters — measured ~113k total, ~90k of them singletons
// (mostly low-confidence junk detections). Hiding single-face clusters keeps
// the People response meaningful and small; the faces still exist and show up
// the moment a second face of that person is found.
export const MIN_FACE_CLUSTER_SIZE = 2;

const MIN_FACE_CLUSTER_PCA_SIZE = 100;

const FACE_CLUSTER_PCA_NEIGHBORS = 10;

const MAX_MERGE_SUGGESTIONS = 6;

/**
 * The People-tab layout (cluster centroids projected to 3D) and the merge
 * suggestions on a person's page, with the caches both read from. Any face,
 * cluster, name or merge change calls invalidateFaceClusterPCACache.
 */
export class FaceClusterLayout {
  private pcaCache: FaceClusterPCAResult | null = null;
  private pcaCacheInflight: Promise<FaceClusterPCAResult> | null = null;
  private seedsCache: FaceClusterPCASeed[] | null = null;
  private seedsCacheInflight: Promise<FaceClusterPCASeed[]> | null = null;
  /**
   * Results derived from the seeds and the faces, kept until the next
   * invalidateFaceClusterPCACache (any face, cluster, name or merge change).
   * Opening a person re-ran all of them: ranking merge suggestions alone is
   * ~1.1 s of dot products for a person with many sub-clusters, and the
   * suggestions' date ranges and filtered counts ~0.6 s of SQL even for a
   * tiny person. `derivedGeneration` keeps a computation that overlapped an
   * invalidation from storing what it read before it.
   */
  private derivedGeneration = 0;
  private suggestionRankingCache = new Map<number, FaceClusterPCASeed[]>();
  private yearRangeLabelCache = new Map<number, string | null>();
  /** Keyed by the filter's SQL and params, then by clusterId. */
  private filteredCountCache = new Map<string, Map<number, number>>();

  constructor(private readonly db: AsyncSqlite) {}

  /** Computes the People-tab PCA layout ahead of the first request for it. */
  async warmPCACache(): Promise<void> {
    this.pcaCache = await this.computePCACache();
  }

  /**
   * Returns face cluster centroids projected to 3D via PCA. Result is cached
   * in memory after the first computation and invalidated whenever the
   * clustering task assigns new faces, so repeated calls are instant.
   */
  async getFaceClustersPCA(clusterId?: string): Promise<FaceClusterPCAResult> {
    if (clusterId) {
      return this.computeFocusedFaceClustersPCA(clusterId);
    }

    if (this.pcaCache) return this.pcaCache;

    // Coalesce concurrent requests onto a single in-flight computation
    if (this.pcaCacheInflight) return this.pcaCacheInflight;

    this.pcaCacheInflight = this.computePCACache().then((result) => {
      this.pcaCache = result;
      this.pcaCacheInflight = null;
      return result;
    });
    return this.pcaCacheInflight;
  }

  invalidateFaceClusterPCACache() {
    this.pcaCache = null;
    this.pcaCacheInflight = null;
    this.seedsCache = null;
    this.seedsCacheInflight = null;
    this.derivedGeneration++;
    this.suggestionRankingCache.clear();
    this.yearRangeLabelCache.clear();
    this.filteredCountCache.clear();
  }

  async computeFocusedFaceClustersPCA(
    clusterId: string,
  ): Promise<FaceClusterPCAResult> {
    const seeds = await this.listFaceClusterPCASeeds(MIN_FACE_CLUSTER_PCA_SIZE);
    const focusedSeed = seeds.find((seed) => seed.id === clusterId);
    if (!focusedSeed) return { points: [] };

    const focusedAndNeighbors = [
      focusedSeed,
      ...seeds
        .filter((seed) => seed.id !== clusterId)
        .map((seed) => ({
          seed,
          similarity: dotFaceClusterVectors(seed.vector, focusedSeed.vector),
        }))
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, FACE_CLUSTER_PCA_NEIGHBORS)
        .map(({ seed }) => seed),
    ];

    return buildFaceClustersPCAResult(focusedAndNeighbors, clusterId);
  }

  async getMergeSuggestions(
    personId: number,
    filter: QueryOptions["filter"],
  ): Promise<FaceClusterSummary[]> {
    const suggestedSeeds = (await this.rankMergeSuggestions(personId)).map((seed) => ({
      seed,
    }));
    if (suggestedSeeds.length === 0) return [];

    // The rest of the detail (faces, count, Match Groups) is scoped to the
    // active filter, so scope the suggested counts to it too — otherwise a
    // suggestion shows its whole-library face count next to filtered numbers.
    // Candidates are all unmerged single clusters (personId === null above), so
    // one grouped count per clusterId is exact. Drop candidates with no faces
    // under the filter: there is nothing filter-relevant to merge.
    const filteredCounts = await this.getFilteredClusterFaceCounts(
      suggestedSeeds.map(({ seed }) => seed.clusterId),
      filter,
    );

    const visibleSuggestions = filteredCounts
      ? suggestedSeeds.flatMap(({ seed }) => {
          const count = filteredCounts.get(seed.clusterId) ?? 0;
          return count > 0 ? [{ seed, count }] : [];
        })
      : suggestedSeeds.map(({ seed }) => ({ seed, count: seed.count }));

    const yearRangeLabels = await this.getFaceClusterYearRangeLabels(
      visibleSuggestions.map(({ seed }) => seed.clusterId),
    );

    return visibleSuggestions.map(({ seed, count }) => ({
      id: seed.id,
      count,
      name: seed.name,
      representative: seed.representative,
      yearRangeLabel: yearRangeLabels.get(seed.clusterId) ?? null,
      // Suggestions are always unmerged single clusters (seed.personId ===
      // null, filtered above), and tags only ever live on a person root —
      // not worth a per-suggestion lookup for a candidate that isn't the
      // real person yet.
      tags: [],
    }));
  }

  /**
   * The unmerged clusters most like any of the person's clusters, best first.
   * Cached per person (see derivedGeneration).
   */
  async rankMergeSuggestions(personId: number): Promise<FaceClusterPCASeed[]> {
    const cached = this.suggestionRankingCache.get(personId);
    if (cached) return cached;
    const generation = this.derivedGeneration;

    const seeds = await this.listFaceClusterPCASeeds(MIN_FACE_CLUSTER_SIZE);
    const personClusterRows = await this.db.all<{ id: number }>(
      `SELECT id FROM faceClusters
       WHERE id = ? OR personId = ?`,
      personId,
      personId,
    );
    const personClusterIds = new Set(personClusterRows.map((row) => row.id));
    const focusedVectors = seeds
      .filter((seed) => personClusterIds.has(seed.clusterId))
      .map((seed) => seed.vector);

    const ranked: FaceClusterPCASeed[] = [];
    if (focusedVectors.length > 0) {
      const scored: Array<{ seed: FaceClusterPCASeed; similarity: number }> = [];
      for (const seed of seeds) {
        if (seed.personId !== null || personClusterIds.has(seed.clusterId)) continue;
        let similarity = Number.NEGATIVE_INFINITY;
        for (const vector of focusedVectors) {
          const dot = dotFaceClusterVectors(seed.vector, vector);
          if (dot > similarity) similarity = dot;
        }
        scored.push({ seed, similarity });
      }
      scored.sort((a, b) => b.similarity - a.similarity || b.seed.count - a.seed.count);
      for (const { seed } of scored.slice(0, MAX_MERGE_SUGGESTIONS)) ranked.push(seed);
    }

    if (generation === this.derivedGeneration) {
      this.suggestionRankingCache.set(personId, ranked);
    }
    return ranked;
  }

  /**
   * Per-cluster face counts restricted to the files that pass `filter`. Returns
   * `null` when there is no filter (callers keep their unfiltered counts) so the
   * default People path pays for no extra query. Starts from the few clusters'
   * faces and checks each face's file, rather than from every file that passes
   * the filter (see getFaceClusterDetail).
   */
  async getFilteredClusterFaceCounts(
    clusterIds: number[],
    filter: QueryOptions["filter"],
  ): Promise<Map<number, number> | null> {
    const { where: whereClause, params: whereParams } = filterToSQL(filter);
    if (!whereClause) return null;
    const uniqueClusterIds = [...new Set(clusterIds.filter((id) => id > 0))];
    if (uniqueClusterIds.length === 0) return new Map();

    const generation = this.derivedGeneration;
    const cacheKey = `${whereClause}\u0000${JSON.stringify(whereParams)}`;
    const cached = this.filteredCountCache.get(cacheKey) ?? new Map<number, number>();
    const missing = uniqueClusterIds.filter((id) => !cached.has(id));
    if (missing.length === 0) return cached;

    const rows = await this.db.all<{ clusterId: number; count: number }>(
      `SELECT faces.clusterId AS clusterId, COUNT(*) AS count
       FROM faces
       WHERE faces.clusterId IN (${missing.map(() => "?").join(", ")})
         AND EXISTS (
           SELECT 1 FROM files
           WHERE files.folder = faces.folder
             AND files.fileName = faces.fileName
             AND (${whereClause})
         )
       GROUP BY faces.clusterId`,
      ...missing,
      ...whereParams,
    );

    const counts = new Map(cached);
    for (const id of missing) counts.set(id, 0);
    for (const row of rows) counts.set(row.clusterId, row.count);
    if (generation === this.derivedGeneration) this.filteredCountCache.set(cacheKey, counts);
    return counts;
  }

  async getFaceClusterYearRangeLabels(
    clusterIds: number[],
  ): Promise<Map<number, string>> {
    const uniqueClusterIds = [
      ...new Set(clusterIds.filter((clusterId) => clusterId > 0)),
    ];
    if (uniqueClusterIds.length === 0) return new Map();

    const generation = this.derivedGeneration;
    const missing = uniqueClusterIds.filter((id) => !this.yearRangeLabelCache.has(id));
    const rows = missing.length === 0 ? [] : await this.db.all<{
      clusterId: number;
      minDate: number | null;
      maxDate: number | null;
    }>(
      `SELECT
         faces.clusterId AS clusterId,
         MIN(COALESCE(files.dateTaken, files.created, files.modified)) AS minDate,
         MAX(COALESCE(files.dateTaken, files.created, files.modified)) AS maxDate
       FROM faces
       JOIN files
         ON files.folder = faces.folder
        AND files.fileName = faces.fileName
       WHERE faces.clusterId IN (${missing.map(() => "?").join(", ")})
       GROUP BY faces.clusterId`,
      ...missing,
    );

    const fresh = new Map<number, string | null>(missing.map((id) => [id, null]));
    for (const row of rows) {
      fresh.set(row.clusterId, formatYearRangeLabel(row.minDate, row.maxDate) || null);
    }
    if (generation === this.derivedGeneration) {
      for (const [id, label] of fresh) this.yearRangeLabelCache.set(id, label);
    }

    const labels = new Map<number, string>();
    for (const id of uniqueClusterIds) {
      const label = fresh.has(id) ? fresh.get(id) : this.yearRangeLabelCache.get(id);
      if (label) labels.set(id, label);
    }
    return labels;
  }

  async listFaceClusterPCASeeds(minCount: number): Promise<FaceClusterPCASeed[]> {
    // Build the cache at MIN_FACE_CLUSTER_SIZE on first call; filter in memory
    // for higher minCount values. Avoids re-reading 218 MB of centroid BLOBs
    // (+ hydrating 25k representative faces, ~1.7s) on every getMergeSuggestions
    // and computeFocusedFaceClustersPCA call.
    if (!this.seedsCache) {
      if (!this.seedsCacheInflight) {
        this.seedsCacheInflight = this.computeSeedsCache().then((seeds) => {
          this.seedsCache = seeds;
          this.seedsCacheInflight = null;
          return seeds;
        });
      }
      const seeds = await this.seedsCacheInflight;
      return minCount <= MIN_FACE_CLUSTER_SIZE
        ? seeds
        : seeds.filter((s) => s.count >= minCount);
    }
    return minCount <= MIN_FACE_CLUSTER_SIZE
      ? this.seedsCache
      : this.seedsCache.filter((s) => s.count >= minCount);
  }

  async computeSeedsCache(): Promise<FaceClusterPCASeed[]> {
    const centroidRows = await runWithoutRequestAbortSignal(() =>
      this.db.all<{
        id: number;
        personId: number | null;
        centroid: Buffer;
        weight: number;
        name: string | null;
      }>(
        `SELECT
           faceClusters.id,
           faceClusters.personId,
           faceClusters.centroid,
           faceClusters.weight,
           COALESCE(personRoots.name, faceClusters.name) AS name
         FROM faceClusters
         LEFT JOIN faceClusters AS personRoots
           ON personRoots.id = faceClusters.personId
         WHERE faceClusters.weight > 0`,
      ),
    );

    if (centroidRows.length === 0) return [];

    const countRows = await runWithoutRequestAbortSignal(() =>
      this.db.all<{ clusterId: number; count: number; id: number }>(
        `SELECT clusterId, COUNT(*) AS count, MAX(clusterSimilarity) AS _, id
         FROM faces
         WHERE clusterId > 0
         GROUP BY clusterId
         HAVING COUNT(*) >= ${MIN_FACE_CLUSTER_SIZE}`,
      ),
    );

    if (countRows.length === 0) return [];

    const countMap = new Map<number, { count: number; faceId: number }>();
    for (const row of countRows) {
      countMap.set(row.clusterId, { count: row.count, faceId: row.id });
    }

    type RepRow = {
      id: number;
      folder: string;
      fileName: string;
      boxX: number;
      boxY: number;
      boxWidth: number;
      boxHeight: number;
      frameTimeMs: number | null;
      mimeType: string | null;
      dimensionWidth: number | null;
      dimensionHeight: number | null;
      regions: string | null;
    };
    const repRows: RepRow[] = [];
    const faceIds = [...countMap.values()].map((value) => value.faceId);
    const CHUNK = 500;
    for (let i = 0; i < faceIds.length; i += CHUNK) {
      const chunk = faceIds.slice(i, i + CHUNK);
      const rows = await runWithoutRequestAbortSignal(() =>
        this.db.all<RepRow>(
          `SELECT
             faces.id AS id,
             faces.folder, faces.fileName,
             faces.boxX, faces.boxY, faces.boxWidth, faces.boxHeight,
             faces.frameTimeMs,
             files.mimeType,
             files.dimensionsWidth AS dimensionWidth,
             files.dimensionsHeight AS dimensionHeight,
             files.regions
           FROM faces
           JOIN files ON files.folder = faces.folder AND files.fileName = faces.fileName
           WHERE faces.id IN (${chunk.map(() => "?").join(", ")})`,
          ...chunk,
        ),
      );
      repRows.push(...rows);
    }

    const repMap = new Map<number, FaceClusterFace>();
    for (const row of repRows) repMap.set(row.id, faceRowToClusterFace(row));

    return centroidRows
      .flatMap((row) => {
        const countEntry = countMap.get(row.id);
        if (!countEntry) return [];
        const representative = repMap.get(countEntry.faceId);
        if (!representative) return [];
        return [
          {
            id: faceClusterIdToString(row.id),
            clusterId: row.id,
            personId: row.personId,
            count: countEntry.count,
            name: row.name ?? null,
            representative,
            vector: normalizeFaceClusterCentroid(
              toAlignedFloat32(row.centroid) as Float32Array<ArrayBuffer>,
            ),
          },
        ];
      })
      .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  }

  async computePCACache(): Promise<FaceClusterPCAResult> {
    const seeds = await this.listFaceClusterPCASeeds(MIN_FACE_CLUSTER_PCA_SIZE);
    return buildFaceClustersPCAResult(seeds);
  }
}
