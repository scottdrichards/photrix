import { AsyncSqlite } from "../common/asyncSqlite.ts";
import { runWithoutRequestAbortSignal } from "../common/requestAbort.ts";
import { filterToSQL } from "./filterToSQL.ts";
import { type FaceClusterCentroid, type FaceClusterDetailResult, type FaceClusterFace, type FaceClusterSummary, type FaceClusterPCAResult, type FaceClusterResult, type FaceReviewFace, type FaceReviewResult, type QueryOptions } from "./indexDatabase.type.ts";
import { encodeEmbedding } from "./embeddingCodec.ts";
import {
  FACE_CLUSTER_SIMILARITY_THRESHOLD,
  FaceClusterEngine,
  type FaceVerdict,
  dotProduct,
  toUnitFloat32,
  LOW_CONFIDENCE_CLUSTER_ID,
  MIN_FACE_CONFIDENCE_FOR_CLUSTERING,
  UNCLUSTERABLE_CLUSTER_ID,
  toAlignedFloat32,
} from "./faceClusterEngine.ts";
import {
  planOptimization,
  scoreAnomalies,
  suggestCutoff,
  type AnomalyInput,
  type OptimizeCluster,
  type OptimizeProposal,
} from "./faceReview.ts";
import {
  collateralOf,
  dot as capDot,
  growCapToInclude,
  minimalEnclosingCap,
  refitCaps,
  shrinkCapToExclude,
  type Cap,
} from "./faceGeometry.ts";
import { computePCA3D } from "./pca.ts";
import { getLogger } from "../observability/logger.ts";
import { attemptSync } from "../common/result.ts";
import { faceClusterIdToString, faceClusterIdFromString } from "./faceClusterId.ts";
import { faceRowToClusterFace } from "./faceRowToClusterFace.ts";
import {
  type ClusterDetailRow,
  videoFaceQuota,
  withVideoFaceShare,
} from "./clusterDetailVideoShare.ts";

const log = getLogger("faceClusters");

// PRAGMA user_version marking that the one-time low-confidence face-cluster
// purge has run (see purgeLowConfidenceFaceClusters). Bump to re-run after a
// future change to the confidence floor.
const LOW_CONFIDENCE_PURGE_VERSION = 1;

// A cluster losing at least this fraction of its members to the confidence
// purge is treated as a junk hub: its confident survivors are freed for
// re-clustering rather than left behind under a junk-derived centroid.
const HUB_RECLUSTER_PURGE_FRACTION = 0.3;

// At a real library's scale (~316k faces) the greedy clustering produces a
// huge tail of tiny clusters — measured ~113k total, ~90k of them singletons
// (mostly low-confidence junk detections). Hiding single-face clusters keeps
// the People response meaningful and small; the faces still exist and show up
// the moment a second face of that person is found.
const MIN_FACE_CLUSTER_SIZE = 2;

const MIN_FACE_CLUSTER_PCA_SIZE = 100;

const FACE_CLUSTER_PCA_NEIGHBORS = 10;

// Caps the summary's cluster list (ordered by size, so this is "the 1000
// biggest people") and the detail's face list. Totals in the response still
// reflect the uncapped numbers. Without caps the summary JSON carried tens of
// thousands of clusters (megabytes) and a big person's detail tens of
// thousands of face entries.
const MAX_FACE_CLUSTERS_LISTED = 1000;

const MAX_FACES_IN_CLUSTER_DETAIL = 2000;

const MAX_MERGE_SUGGESTIONS = 6;

// Face rows are stored per file; cluster ids are exposed to the client as
// opaque strings. Keep the "person-" prefix stable — it's part of the API.
/** Parses a `faceClusters.tags` JSON-array column; NULL/malformed -> []. */
const parsePersonTags = (raw: string | null): string[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
};

const normalizeFaceClusterCentroid = (
  vector: Float32Array<ArrayBuffer>,
): Float32Array<ArrayBuffer> => {
  let magnitude = 0;
  for (let i = 0; i < vector.length; i++) magnitude += vector[i] * vector[i];
  magnitude = Math.sqrt(magnitude);
  if (magnitude < 1e-10) return vector;
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = vector[i] / magnitude;
  return out;
};

const dotFaceClusterVectors = (
  a: Float32Array<ArrayBuffer>,
  b: Float32Array<ArrayBuffer>,
): number => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
};


const formatYearRangeLabel = (
  minDate: number | null,
  maxDate: number | null,
): string | null => {
  if (
    minDate === null ||
    maxDate === null ||
    !Number.isFinite(minDate) ||
    !Number.isFinite(maxDate)
  ) {
    return null;
  }

  const startYear = new Date(minDate).getUTCFullYear();
  const endYear = new Date(maxDate).getUTCFullYear();
  return startYear === endYear ? String(startYear) : `${startYear}-${endYear}`;
};

// PRAGMA user_version marking that the one-time rescore of already-merged
// sub-clusters against their canonical centroid has run (see
// rescoreMergedClusterSimilarities). Runs after the purge, so it must sit above
// LOW_CONFIDENCE_PURGE_VERSION in this monotonically-increasing scheme.
const MERGED_SIMILARITY_RESCORE_VERSION = 2;

type FaceClusterPCASeed = {
  id: string;
  clusterId: number;
  personId: number | null;
  count: number;
  name: string | null;
  representative: FaceClusterFace;
  vector: Float32Array<ArrayBuffer>;
};

/** People as clusters of faces: clustering, the People-tab layout, merges, review and cluster geometry. */
export class FaceClusterStore {
  private pcaCache: FaceClusterPCAResult | null = null;
  private pcaCacheInflight: Promise<FaceClusterPCAResult> | null = null;
  private seedsCache: FaceClusterPCASeed[] | null = null;
  private seedsCacheInflight: Promise<FaceClusterPCASeed[]> | null = null;

  constructor(
    private readonly db: AsyncSqlite,
    private readonly faceClusters: FaceClusterEngine,
    private readonly invalidateStatusCountsCache: () => void,
  ) {}

  /** Computes the People-tab PCA layout ahead of the first request for it. */
  async warmPCACache(): Promise<void> {
    this.pcaCache = await this.computePCACache();
  }

  async queryFaceClusters(options: {
    filter: QueryOptions["filter"];
  }): Promise<FaceClusterResult> {
    const { filter } = options;
    const { where: whereClause, params: whereParams } = filterToSQL(filter);

    // Step 1: per-cluster count + representative face id. SQLite bare-column
    // semantics: with a MAX() aggregate, non-aggregated columns take their
    // values from the row that produced the max — so `id` here is the face
    // with the highest centroid similarity per cluster (its representative).
    //
    // With no filter (the People tab's default) this is a pure scan of the
    // by_cluster covering index — ~0.15s over 358k faces. The old formulation
    // joined 111k faceClusters rows for COALESCE(personId, clusterId) and
    // sorted 25k groups taking ~4s. With only ~13 merged centroids, JS-side
    // merge is negligible.
    //
    // The filtered variant forces the join order: MATERIALIZED pins the
    // filtered file set, and CROSS JOIN makes it the driving table so faces
    // are probed through the by_file_v3 covering index. Left to itself the
    // planner drove the join from all ~300k clustered faces instead, fetching
    // each face row (and its embedding BLOB pages) to get folder/fileName —
    // ~14s vs ~0.2s under a face filter.
    let aggregateRows: { personId: number; count: number; id: number }[];
    if (whereClause) {
      aggregateRows = await this.db.all<{ personId: number; count: number; id: number }>(
        `WITH filtered_files AS MATERIALIZED (
           SELECT folder, fileName FROM files WHERE ${whereClause}
         )
         SELECT
           COALESCE(faceClusters.personId, faces.clusterId) AS personId,
           COUNT(*) AS count,
           MAX(faces.clusterSimilarity) AS representativeSimilarity,
           faces.id AS id
         FROM filtered_files
         CROSS JOIN faces
            ON faces.folder = filtered_files.folder
           AND faces.fileName = filtered_files.fileName
         JOIN faceClusters
           ON faceClusters.id = faces.clusterId
         WHERE faces.clusterId > 0
         GROUP BY COALESCE(faceClusters.personId, faces.clusterId)
         HAVING COUNT(*) >= ${MIN_FACE_CLUSTER_SIZE}
         ORDER BY COUNT(*) DESC, personId`,
        ...whereParams,
      );
    } else {
      // Index-only aggregation: GROUP BY raw clusterId uses the by_cluster
      // covering index without touching face rows or joining faceClusters.
      const clusterRows = await this.db.all<{
        clusterId: number;
        count: number;
        representativeSimilarity: number;
        id: number;
      }>(
        `SELECT clusterId, COUNT(*) AS count,
                MAX(clusterSimilarity) AS representativeSimilarity, id
         FROM faces
         WHERE clusterId > 0
         GROUP BY clusterId
         HAVING COUNT(*) >= ${MIN_FACE_CLUSTER_SIZE}
         ORDER BY COUNT(*) DESC, clusterId`,
      );
      // Merge per-centroid rows into per-person groups in JS.
      // The mergeMap covers only the ~13 faceClusters rows with personId set.
      const mergeRows = await this.db.all<{ id: number; personId: number }>(
        "SELECT id, personId FROM faceClusters WHERE personId IS NOT NULL",
      );
      const mergeMap = new Map(mergeRows.map((r) => [r.id, r.personId]));
      const personMap = new Map<
        number,
        { count: number; repSimilarity: number; id: number }
      >();
      for (const row of clusterRows) {
        const personId = mergeMap.get(row.clusterId) ?? row.clusterId;
        const existing = personMap.get(personId);
        if (!existing) {
          personMap.set(personId, {
            count: row.count,
            repSimilarity: row.representativeSimilarity,
            id: row.id,
          });
        } else {
          existing.count += row.count;
          if (row.representativeSimilarity > existing.repSimilarity) {
            existing.repSimilarity = row.representativeSimilarity;
            existing.id = row.id;
          }
        }
      }
      aggregateRows = [...personMap.entries()]
        .map(([personId, data]) => ({ personId, count: data.count, id: data.id }))
        .sort((a, b) => b.count - a.count || a.personId - b.personId);
    }

    // Same join-order forcing as above. Only faces that pass the clusterId IS
    // NULL index constraint get a row fetch (for the LENGTH check), so the
    // BLOB drag is limited to the actual pending backlog. Without a filter the
    // needing_cluster partial index answers the count directly.
    const pendingRow = whereClause
      ? await this.db.get<{ count: number }>(
          `WITH filtered_files AS MATERIALIZED (
             SELECT folder, fileName FROM files WHERE ${whereClause}
           )
           SELECT COUNT(*) AS count
           FROM filtered_files
           CROSS JOIN faces
             ON faces.folder = filtered_files.folder
            AND faces.fileName = filtered_files.fileName
           WHERE faces.clusterId IS NULL`,
          ...whereParams,
        )
      : await this.db.get<{ count: number }>(
          `SELECT COUNT(*) AS count FROM faces WHERE clusterId IS NULL`,
        );

    // Step 2: hydrate the representative faces — only for the clusters the
    // response actually lists.
    const listed = aggregateRows.slice(0, MAX_FACE_CLUSTERS_LISTED);
    const representatives = new Map<number, FaceClusterFace>();
    const clusterNames = new Map<number, string | null>();
    const clusterTags = new Map<number, string | null>();
    if (listed.length) {
      const representativeRows = await this.db.all<{
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
      }>(
        `SELECT
           faces.id AS id,
           faces.folder,
           faces.fileName,
           faces.boxX,
           faces.boxY,
           faces.boxWidth,
           faces.boxHeight,
           faces.frameTimeMs,
           files.mimeType,
           files.dimensionsWidth AS dimensionWidth,
           files.dimensionsHeight AS dimensionHeight,
           files.regions
         FROM faces
         JOIN files
           ON files.folder = faces.folder
          AND files.fileName = faces.fileName
         WHERE faces.id IN (${listed.map(() => "?").join(", ")})`,
        ...listed.map((row) => row.id),
      );
      for (const row of representativeRows) {
        representatives.set(row.id, faceRowToClusterFace(row));
      }

      const nameRows = await this.db.all<{
        id: number;
        name: string | null;
        tags: string | null;
      }>(
        `SELECT id, name, tags FROM faceClusters WHERE id IN (${listed.map(() => "?").join(", ")})`,
        ...listed.map((row) => row.personId),
      );
      for (const row of nameRows) {
        clusterNames.set(row.id, row.name);
        clusterTags.set(row.id, row.tags);
      }
    }

    const clusters = listed.flatMap((row) => {
      const representative = representatives.get(row.id);
      if (!representative) return [];
      return [
        {
          id: faceClusterIdToString(row.personId),
          count: row.count,
          representative,
          name: clusterNames.get(row.personId) ?? null,
          tags: parsePersonTags(clusterTags.get(row.personId) ?? null),
        },
      ];
    });

    return {
      clusters,
      totalFaces: aggregateRows.reduce((sum, row) => sum + row.count, 0),
      totalClusters: aggregateRows.length,
      pendingFaces: pendingRow?.count ?? 0,
    };
  }

  async getFaceClusterDetail(options: {
    filter: QueryOptions["filter"];
    clusterId: string;
    /**
     * Feedback #105: opening a person always resolves up to the merged
     * "canonical" person id (`effectivePersonId` below) so the whole family
     * of merged sub-clusters shows as one page. But the "Match Groups"
     * panel on that page lets you view one merged-in sub-cluster on its
     * own — passing `exactCluster: true` there keeps the face query scoped
     * to the literal `clusterId` requested instead of re-widening back out
     * to every face under the merged person, which silently made "View" on
     * a match group a no-op (it just showed the same full person again).
     */
    exactCluster?: boolean;
    /** Most faces to return; defaults to MAX_FACES_IN_CLUSTER_DETAIL. */
    maxFaces?: number;
  }): Promise<FaceClusterDetailResult> {
    const { filter, clusterId, exactCluster = false } = options;
    const cap = options.maxFaces ?? MAX_FACES_IN_CLUSTER_DETAIL;
    const numericClusterId = faceClusterIdFromString(clusterId);
    if (numericClusterId === null || numericClusterId <= 0) {
      return { cluster: null };
    }

    const clusterRow = await this.db.get<{ id: number; personId: number | null }>(
      "SELECT id, personId FROM faceClusters WHERE id = ?",
      numericClusterId,
    );
    if (!clusterRow) {
      return { cluster: null };
    }

    const effectivePersonId = clusterRow.personId ?? clusterRow.id;
    // unmerged persons (99.9% of cases) can bypass the COALESCE join that
    // forced a full scan of all 111k faceClusters rows (~470ms per query);
    // the direct clusterId = ? lookup uses the by_cluster covering index (1ms).
    // An explicit `exactCluster` request takes the same fast direct-id path
    // even when the cluster *is* merged, since it deliberately wants just
    // that one sub-cluster's faces rather than the merged person's.
    const isUnmerged = clusterRow.personId === null;
    const useDirectClusterFilter = isUnmerged || exactCluster;
    // The id the *faces* queries below scope to — the merged person for a
    // normal "open this person" request, or the literal requested cluster
    // for an exactCluster request. Metadata (name/tags/sibling centroids)
    // below intentionally keeps using effectivePersonId regardless — a
    // merged-in sub-cluster has no name of its own, and callers that pass
    // exactCluster only ever read `.faces` off the result.
    const faceScopeId = useDirectClusterFilter ? numericClusterId : effectivePersonId;

    const { where: whereClause, params: whereParams } = filterToSQL(filter);

    // The `limited` CTE selects the top-N face ids entirely inside covering
    // indexes (by_cluster unfiltered; filtered_files probing by_file_v3 under
    // a filter — MATERIALIZED + CROSS JOIN force that join order, see
    // queryFaceClusters). Only the N surviving rows are then fetched from
    // faces/files for box and dimension columns, keeping the embedding-BLOB
    // page drag proportional to the response, not the cluster size. The
    // redundant clusterId > 0 term lets the planner prove the by_cluster
    // partial index applies even though the cluster id is a bound parameter.
    const limitedCTE = whereClause
      ? `WITH filtered_files AS MATERIALIZED (
           SELECT folder, fileName FROM files WHERE ${whereClause}
          ),
          limited AS (
            SELECT faces.id AS id
            FROM filtered_files
            CROSS JOIN faces
              ON faces.folder = filtered_files.folder
             AND faces.fileName = filtered_files.fileName
            ${
              useDirectClusterFilter
                ? `WHERE faces.clusterId > 0 AND faces.clusterId = ?`
                : `JOIN faceClusters
                     ON faceClusters.id = faces.clusterId
                   WHERE faces.clusterId > 0
                     AND COALESCE(faceClusters.personId, faces.clusterId) = ?`
            }
            ORDER BY faces.clusterSimilarity DESC, faces.id
            LIMIT ${cap}
          )`
      : useDirectClusterFilter
        ? `WITH limited AS (
             SELECT id FROM faces
             WHERE clusterId > 0 AND clusterId = ?
             ORDER BY clusterSimilarity DESC, id
             LIMIT ${cap}
           )`
        : `WITH limited AS (
             SELECT faces.id AS id
             FROM faces
             JOIN faceClusters
               ON faceClusters.id = faces.clusterId
             WHERE faces.clusterId > 0
               AND COALESCE(faceClusters.personId, faces.clusterId) = ?
             ORDER BY faces.clusterSimilarity DESC, faces.id
             LIMIT ${cap}
           )`;

    const detailRowColumns = `
         faces.id,
         faces.folder,
         faces.fileName,
         faces.boxX,
         faces.boxY,
         faces.boxWidth,
         faces.boxHeight,
         faces.frameTimeMs,
         faces.clusterSimilarity,
         files.mimeType,
         files.dimensionsWidth AS dimensionWidth,
         files.dimensionsHeight AS dimensionHeight,
         files.regions,
         files.dateTaken`;

    let rows = await this.db.all<ClusterDetailRow>(
      `${limitedCTE}
       SELECT ${detailRowColumns}
       FROM limited
       JOIN faces
         ON faces.id = limited.id
       JOIN files
         ON files.folder = faces.folder
        AND files.fileName = faces.fileName
       ORDER BY faces.clusterSimilarity DESC, faces.id`,
      ...whereParams,
      faceScopeId,
    );

    if (!rows.length) {
      return { cluster: null };
    }

    // `count` reflects the whole cluster within the filter even when the faces
    // list is capped; the unfiltered unmerged path is pure index-only (1ms);
    // the COALESCE variant is kept only for merged persons and filtered queries.
    const countRow = whereClause
      ? useDirectClusterFilter
        ? await this.db.get<{ count: number }>(
            `WITH filtered_files AS MATERIALIZED (
               SELECT folder, fileName FROM files WHERE ${whereClause}
             )
             SELECT COUNT(*) AS count
             FROM filtered_files
             CROSS JOIN faces
               ON faces.folder = filtered_files.folder
              AND faces.fileName = filtered_files.fileName
             WHERE faces.clusterId = ?
               AND faces.clusterId > 0`,
            ...whereParams,
            faceScopeId,
          )
        : await this.db.get<{ count: number }>(
            `WITH filtered_files AS MATERIALIZED (
               SELECT folder, fileName FROM files WHERE ${whereClause}
             )
             SELECT COUNT(*) AS count
             FROM filtered_files
             CROSS JOIN faces
               ON faces.folder = filtered_files.folder
              AND faces.fileName = filtered_files.fileName
             JOIN faceClusters
               ON faceClusters.id = faces.clusterId
             WHERE COALESCE(faceClusters.personId, faces.clusterId) = ?
               AND faces.clusterId > 0`,
            ...whereParams,
            faceScopeId,
          )
      : useDirectClusterFilter
        ? await this.db.get<{ count: number }>(
            `SELECT COUNT(*) AS count FROM faces
             WHERE clusterId > 0 AND clusterId = ?`,
            faceScopeId,
          )
        : await this.db.get<{ count: number }>(
            `SELECT COUNT(*) AS count
             FROM faces
             JOIN faceClusters
               ON faceClusters.id = faces.clusterId
             WHERE faces.clusterId > 0
               AND COALESCE(faceClusters.personId, faces.clusterId) = ?`,
            faceScopeId,
          );

    // Feedback #153: past the cap, best-match-first starves video faces. A
    // face cut from a video frame is blurrier than a photo's and scores a
    // lower clusterSimilarity, so a person with 12% video faces got 1.6% of
    // the 2000 shown. Over the cap, give videos their proportional share,
    // taking the person's best-matching video faces. The list stays in
    // similarity order, which the client's "Best match" / "Least alike first"
    // sorts rely on. Only capped people pay for the two extra queries.
    const total = countRow?.count ?? rows.length;
    if (total > rows.length) {
      // The person's clusters are resolved first and probed with IN: the
      // COALESCE join the main query uses walks every faceClusters row, which
      // cost ~235 ms here against ~22 ms this way for the largest person. A
      // filter goes on the file side, where "is a video" is mimeType (the
      // same faces as frameTimeMs IS NOT NULL, measured over every face).
      const clusterScope = useDirectClusterFilter
        ? `faces.clusterId = ?`
        : `faces.clusterId IN (
             SELECT id FROM faceClusters WHERE COALESCE(personId, id) = ?
           )`;
      const videoFaces = whereClause
        ? `WITH filtered_files AS MATERIALIZED (
             SELECT folder, fileName FROM files
             WHERE (${whereClause}) AND mimeType LIKE 'video/%'
           ),
           video_faces AS (
             SELECT faces.id, faces.clusterSimilarity
             FROM filtered_files
             CROSS JOIN faces
               ON faces.folder = filtered_files.folder
              AND faces.fileName = filtered_files.fileName
             WHERE faces.clusterId > 0 AND ${clusterScope}
           )`
        : `WITH video_faces AS (
             SELECT faces.id, faces.clusterSimilarity
             FROM faces
             WHERE faces.clusterId > 0
               AND faces.frameTimeMs IS NOT NULL
               AND ${clusterScope}
           )`;
      const videoCountRow = await this.db.get<{ count: number }>(
        `${videoFaces}
         SELECT COUNT(*) AS count FROM video_faces`,
        ...whereParams,
        faceScopeId,
      );
      const quota = videoFaceQuota(cap, total, videoCountRow?.count ?? 0);
      const shown = rows.filter((row) => row.frameTimeMs !== null).length;
      if (quota > shown) {
        const videoRows = await this.db.all<ClusterDetailRow>(
          `${videoFaces},
           limited AS (
             SELECT id FROM video_faces
             ORDER BY clusterSimilarity DESC, id
             LIMIT ${quota}
           )
           SELECT ${detailRowColumns}
           FROM limited
           JOIN faces
             ON faces.id = limited.id
           JOIN files
             ON files.folder = faces.folder
            AND files.fileName = faces.fileName
           ORDER BY faces.clusterSimilarity DESC, faces.id`,
          ...whereParams,
          faceScopeId,
        );
        rows = withVideoFaceShare(rows, videoRows, cap);
      }
    }

    const faces = rows.map(faceRowToClusterFace);
    const nameRow = await this.db.get<{ name: string | null; tags: string | null }>(
      "SELECT name, tags FROM faceClusters WHERE id = ?",
      effectivePersonId,
    );

    const centroidAggregateRows = whereClause
      ? await this.db.all<{ clusterId: number; count: number; id: number }>(
          `WITH filtered_files AS MATERIALIZED (
             SELECT folder, fileName FROM files WHERE ${whereClause}
           )
           SELECT
             faces.clusterId AS clusterId,
             COUNT(*) AS count,
             MAX(faces.clusterSimilarity) AS representativeSimilarity,
             faces.id AS id
           FROM filtered_files
           CROSS JOIN faces
             ON faces.folder = filtered_files.folder
            AND faces.fileName = filtered_files.fileName
           JOIN faceClusters
             ON faceClusters.id = faces.clusterId
           WHERE faces.clusterId > 0
             AND COALESCE(faceClusters.personId, faces.clusterId) = ?
           GROUP BY faces.clusterId
           ORDER BY COUNT(*) DESC, faces.clusterId`,
          ...whereParams,
          effectivePersonId,
        )
      : isUnmerged
        ? await this.db.all<{ clusterId: number; count: number; id: number }>(
            `SELECT clusterId, COUNT(*) AS count,
                    MAX(clusterSimilarity) AS representativeSimilarity, id
             FROM faces
             WHERE clusterId > 0 AND clusterId = ?
             GROUP BY clusterId`,
            effectivePersonId,
          )
        : await this.db.all<{ clusterId: number; count: number; id: number }>(
            `SELECT
               faces.clusterId AS clusterId,
               COUNT(*) AS count,
               MAX(faces.clusterSimilarity) AS representativeSimilarity,
               faces.id AS id
             FROM faces
             JOIN faceClusters
               ON faceClusters.id = faces.clusterId
             WHERE faces.clusterId > 0
               AND COALESCE(faceClusters.personId, faces.clusterId) = ?
             GROUP BY faces.clusterId
             ORDER BY COUNT(*) DESC, faces.clusterId`,
            effectivePersonId,
          );

    const centroidRepresentatives = new Map<number, FaceClusterFace>();
    if (centroidAggregateRows.length > 0) {
      const representativeRows = await this.db.all<{
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
      }>(
        `SELECT
           faces.id AS id,
           faces.folder,
           faces.fileName,
           faces.boxX,
           faces.boxY,
           faces.boxWidth,
           faces.boxHeight,
           faces.frameTimeMs,
           files.mimeType,
           files.dimensionsWidth AS dimensionWidth,
           files.dimensionsHeight AS dimensionHeight,
           files.regions
         FROM faces
         JOIN files
           ON files.folder = faces.folder
          AND files.fileName = faces.fileName
         WHERE faces.id IN (${centroidAggregateRows.map(() => "?").join(", ")})`,
        ...centroidAggregateRows.map((row) => row.id),
      );
      for (const row of representativeRows) {
        centroidRepresentatives.set(row.id, faceRowToClusterFace(row));
      }
    }

    const centroids: FaceClusterCentroid[] = centroidAggregateRows.flatMap((row) => {
      const representative = centroidRepresentatives.get(row.id);
      if (!representative) return [];
      return [
        {
          id: faceClusterIdToString(row.clusterId),
          count: row.count,
          representative,
        },
      ];
    });

    const mergeSuggestions = await this.getMergeSuggestions(effectivePersonId, filter);

    return {
      cluster: {
        id: faceClusterIdToString(effectivePersonId),
        count: countRow?.count ?? faces.length,
        representative: faces[0],
        faces,
        name: nameRow?.name ?? null,
        tags: parsePersonTags(nameRow?.tags ?? null),
        centroids,
        mergeSuggestions,
      },
    };
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
  }

  private buildFaceClustersPCAResult(
    seeds: FaceClusterPCASeed[],
    focusedClusterId: string | null = null,
  ): FaceClusterPCAResult {
    if (seeds.length === 0) return { points: [] };

    const coords = computePCA3D(seeds.map((seed) => seed.vector));
    const focusedIndex = focusedClusterId
      ? seeds.findIndex((seed) => seed.id === focusedClusterId)
      : -1;
    const focusOrigin = focusedIndex >= 0 ? coords[focusedIndex] : null;

    return {
      points: seeds.map((seed, index) => ({
        id: seed.id,
        count: seed.count,
        name: seed.name,
        representative: seed.representative,
        x: coords[index][0] - (focusOrigin?.[0] ?? 0),
        y: coords[index][1] - (focusOrigin?.[1] ?? 0),
        z: coords[index][2] - (focusOrigin?.[2] ?? 0),
        focused: seed.id === focusedClusterId,
      })),
    };
  }

  private async computeFocusedFaceClustersPCA(
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

    return this.buildFaceClustersPCAResult(focusedAndNeighbors, clusterId);
  }

  private async getMergeSuggestions(
    personId: number,
    filter: QueryOptions["filter"],
  ): Promise<FaceClusterSummary[]> {
    const seeds = await this.listFaceClusterPCASeeds(MIN_FACE_CLUSTER_SIZE);
    const personClusterRows = await this.db.all<{ id: number }>(
      `SELECT id FROM faceClusters
       WHERE id = ? OR personId = ?`,
      personId,
      personId,
    );
    const personClusterIds = new Set(personClusterRows.map((row) => row.id));
    const focusedSeeds = seeds.filter((seed) => personClusterIds.has(seed.clusterId));
    if (focusedSeeds.length === 0) return [];

    const suggestedSeeds = seeds
      .filter((seed) => seed.personId === null && !personClusterIds.has(seed.clusterId))
      .map((seed) => ({
        seed,
        similarity: Math.max(
          ...focusedSeeds.map((focusedSeed) =>
            dotFaceClusterVectors(seed.vector, focusedSeed.vector),
          ),
        ),
      }))
      .sort((a, b) => b.similarity - a.similarity || b.seed.count - a.seed.count)
      .slice(0, MAX_MERGE_SUGGESTIONS);

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
   * Per-cluster face counts restricted to the files that pass `filter`. Returns
   * `null` when there is no filter (callers keep their unfiltered counts) so the
   * default People path pays for no extra query. Uses the same MATERIALIZED +
   * CROSS JOIN join-order forcing as queryFaceClusters to stay index-only.
   */
  private async getFilteredClusterFaceCounts(
    clusterIds: number[],
    filter: QueryOptions["filter"],
  ): Promise<Map<number, number> | null> {
    const { where: whereClause, params: whereParams } = filterToSQL(filter);
    if (!whereClause) return null;
    const uniqueClusterIds = [...new Set(clusterIds.filter((id) => id > 0))];
    if (uniqueClusterIds.length === 0) return new Map();

    const rows = await this.db.all<{ clusterId: number; count: number }>(
      `WITH filtered_files AS MATERIALIZED (
         SELECT folder, fileName FROM files WHERE ${whereClause}
       )
       SELECT faces.clusterId AS clusterId, COUNT(*) AS count
       FROM filtered_files
       CROSS JOIN faces
         ON faces.folder = filtered_files.folder
        AND faces.fileName = filtered_files.fileName
       WHERE faces.clusterId IN (${uniqueClusterIds.map(() => "?").join(", ")})
       GROUP BY faces.clusterId`,
      ...whereParams,
      ...uniqueClusterIds,
    );

    return new Map(rows.map((row) => [row.clusterId, row.count]));
  }

  private async getFaceClusterYearRangeLabels(
    clusterIds: number[],
  ): Promise<Map<number, string>> {
    const uniqueClusterIds = [
      ...new Set(clusterIds.filter((clusterId) => clusterId > 0)),
    ];
    if (uniqueClusterIds.length === 0) return new Map();

    const rows = await this.db.all<{
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
       WHERE faces.clusterId IN (${uniqueClusterIds.map(() => "?").join(", ")})
       GROUP BY faces.clusterId`,
      ...uniqueClusterIds,
    );

    return new Map(
      rows.flatMap((row) => {
        const label = formatYearRangeLabel(row.minDate, row.maxDate);
        return label ? [[row.clusterId, label] as const] : [];
      }),
    );
  }

  private async listFaceClusterPCASeeds(minCount: number): Promise<FaceClusterPCASeed[]> {
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

  private async computeSeedsCache(): Promise<FaceClusterPCASeed[]> {
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
    return this.buildFaceClustersPCAResult(seeds);
  }

  /**
   * Assigns one batch of not-yet-clustered faces (best detections first, so
   * early centroids are built from confident faces) to persistent clusters.
   * Returns the number of faces handled; 0 means the backlog is drained.
   *
   * The id list and the embedding fetch are separate queries on purpose:
   * sorting must not drag 4 KB embedding BLOBs through the sorter (that was
   * the dominant cost of the old per-request clustering).
   */
  async clusterPendingFaces(batchSize = 256): Promise<number> {
    const idRows = await this.db.all<{ id: number }>(
      `SELECT id FROM faces
       WHERE clusterId IS NULL
       ORDER BY confidence DESC
       LIMIT ?`,
      batchSize,
    );
    if (!idRows.length) return 0;

    const faces = await this.db.all<{
      id: number;
      embedding: Buffer;
      confidence: number | null;
    }>(
      `SELECT f.id, fe.embedding, f.confidence FROM faces f
       JOIN faceEmbeddings fe ON fe.faceId = f.id
       WHERE f.id IN (${idRows.map(() => "?").join(", ")})`,
      ...idRows.map((row) => row.id),
    );

    // The id query selects on clusterId alone, which assumes every unassigned
    // face has an embedding row (the migration and detectFaces both stamp
    // UNCLUSTERABLE otherwise). Self-heal if that invariant ever breaks —
    // without this, a face with no embedding would be re-selected forever and
    // the backfill's "handled > 0" loop would never drain.
    if (faces.length < idRows.length) {
      const withEmbeddings = new Set(faces.map((face) => face.id));
      const orphaned = idRows.filter((row) => !withEmbeddings.has(row.id));
      await this.db.transaction(
        orphaned.map((row) => ({
          sql: "UPDATE faces SET clusterId = ? WHERE id = ?",
          params: [UNCLUSTERABLE_CLUSTER_ID, row.id],
        })),
      );
      log.warn(
        { count: orphaned.length },
        "Unassigned faces had no embedding row; marked unclusterable",
      );
    }

    await this.faceClusters.assignFaces(faces);
    // Cluster membership changed — drop the PCA cache so the next request recomputes
    this.invalidateFaceClusterPCACache();
    return idRows.length;
  }

  async pruneEmptyFaceClusters(): Promise<void> {
    await this.faceClusters.pruneEmptyClusters();
    this.invalidateFaceClusterPCACache();
  }

  /**
   * One-time migration (gated by PRAGMA user_version) that retires the hub
   * "garbage" clusters that formed before the confidence gate: low-confidence
   * detections that collapsed into a few magnet clusters mixing non-faces with
   * a thin tail of real faces.
   *
   * Runs before the engine loads its centroids, so its lazy load reflects the
   * post-purge DB. Idempotent regardless of the version guard (a re-run finds no
   * sub-floor clustered faces and no contaminated clusters), so setting the
   * version after the mutations is safe even if the process dies in between.
   */
  async purgeLowConfidenceFaceClusters(): Promise<void> {
    const versionRow = await this.db.get<{ user_version: number }>(
      "PRAGMA user_version",
    );
    if ((versionRow?.user_version ?? 0) >= LOW_CONFIDENCE_PURGE_VERSION) return;

    // Hubs are defined by their junk: when the sub-floor faces are a large share
    // of a cluster, its confident survivors aren't necessarily one person, so
    // free them (clusterId NULL) for the backfill to re-cluster cleanly. A
    // healthy cluster that merely sheds a straggler keeps its assignment — the
    // leftover ghost weight in its centroid is negligible and self-corrects.
    const contaminated = await this.db.all<{ clusterId: number }>(
      `SELECT clusterId FROM faces
       WHERE clusterId > 0
       GROUP BY clusterId
       HAVING SUM(CASE WHEN confidence < ? THEN 1 ELSE 0 END) * 1.0 / COUNT(*) >= ?
          AND SUM(CASE WHEN confidence >= ? THEN 1 ELSE 0 END) > 0`,
      MIN_FACE_CONFIDENCE_FOR_CLUSTERING,
      HUB_RECLUSTER_PURGE_FRACTION,
      MIN_FACE_CONFIDENCE_FOR_CLUSTERING,
    );
    const contaminatedIds = contaminated.map((row) => row.clusterId);

    const statements: Array<{ sql: string; params: unknown[] }> = [
      // Evict every sub-floor detection to the low-confidence sentinel.
      {
        sql: "UPDATE faces SET clusterId = ?, clusterSimilarity = NULL WHERE clusterId > 0 AND confidence < ?",
        params: [LOW_CONFIDENCE_CLUSTER_ID, MIN_FACE_CONFIDENCE_FOR_CLUSTERING],
      },
    ];
    // Free the confident survivors of hub clusters for re-clustering.
    for (let i = 0; i < contaminatedIds.length; i += 500) {
      const chunk = contaminatedIds.slice(i, i + 500);
      statements.push({
        sql: `UPDATE faces SET clusterId = NULL, clusterSimilarity = NULL
              WHERE clusterId IN (${chunk.map(() => "?").join(", ")})`,
        params: chunk,
      });
    }
    // Drop centroid rows left with no confident members: the fully-emptied hubs
    // and the contaminated clusters whose survivors we just reset to NULL.
    statements.push({
      sql: "DELETE FROM faceClusters WHERE id NOT IN (SELECT DISTINCT clusterId FROM faces WHERE clusterId > 0)",
      params: [],
    });

    await this.db.transaction(statements);
    // PRAGMA can't run inside the batch transaction and can't be parameterized;
    // the version is a trusted integer literal.
    await this.db.exec(`PRAGMA user_version = ${LOW_CONFIDENCE_PURGE_VERSION}`);
    this.invalidateFaceClusterPCACache();
    log.info(
      { reclusteredHubs: contaminatedIds.length },
      "Purged low-confidence face detections from clustering",
    );
  }

  /**
   * One-time migration (gated by PRAGMA user_version) that rescores the stored
   * clusterSimilarity of already-merged sub-clusters against their person's
   * canonical centroid. Before rescore-on-merge existed, merging only regrouped
   * personId and left each sub-cluster's seed pinned at 1.0, so a merged
   * person's representative/detail order surfaced arbitrary sub-cluster seeds
   * (often tiny background faces) ahead of the real centroid faces. Idempotent:
   * a re-run recomputes the same similarities.
   */
  async rescoreMergedClusterSimilarities(): Promise<void> {
    const versionRow = await this.db.get<{ user_version: number }>(
      "PRAGMA user_version",
    );
    if ((versionRow?.user_version ?? 0) >= MERGED_SIMILARITY_RESCORE_VERSION) return;

    // Sub-clusters are the rows whose personId points at a *different* canonical
    // cluster; the canonical cluster's own faces are already scored against its
    // centroid. Group the sub-clusters by their canonical id and rescore each
    // group's faces against that canonical centroid.
    const subClusters = await this.db.all<{ id: number; personId: number }>(
      "SELECT id, personId FROM faceClusters WHERE personId IS NOT NULL AND personId != id",
    );
    const byCanonical = new Map<number, number[]>();
    for (const row of subClusters) {
      const list = byCanonical.get(row.personId) ?? [];
      list.push(row.id);
      byCanonical.set(row.personId, list);
    }
    for (const [canonicalId, subjectIds] of byCanonical) {
      await this.faceClusters.rescoreFacesAgainstCluster(canonicalId, subjectIds);
    }

    await this.db.exec(`PRAGMA user_version = ${MERGED_SIMILARITY_RESCORE_VERSION}`);
    this.invalidateFaceClusterPCACache();
    log.info(
      { persons: byCanonical.size, subClusters: subClusters.length },
      "Rescored merged sub-cluster similarities against canonical centroids",
    );
  }

  /**
   * Rescores stored per-face similarities against current centroids for drifted
   * clusters, so People-tab representatives stop sticking to the seed face.
   * Returns the number of clusters refreshed; 0 means nothing was stale.
   */
  refreshStaleClusterSimilarities(): Promise<number> {
    return this.faceClusters.refreshStaleClusterSimilarities();
  }

  async renameCluster(clusterId: string, name: string | null): Promise<boolean> {
    const numericId = faceClusterIdFromString(clusterId);
    if (numericId === null || numericId <= 0) return false;

    const clusterRow = await this.db.get<{ id: number; personId: number | null }>(
      "SELECT id, personId FROM faceClusters WHERE id = ?",
      numericId,
    );
    if (!clusterRow) return false;

    const normalizedName = typeof name === "string" ? name.trim() || null : null;
    const effectivePersonId = clusterRow.personId ?? clusterRow.id;

    if (normalizedName === null) {
      if (clusterRow.personId === null) {
        await this.db.run(
          "UPDATE faceClusters SET name = NULL WHERE id = ?",
          clusterRow.id,
        );
      } else {
        await this.db.transaction([
          {
            sql: "UPDATE faceClusters SET name = NULL WHERE id = ? OR personId = ?",
            params: [effectivePersonId, effectivePersonId],
          },
          {
            sql: "UPDATE faceClusters SET personId = NULL WHERE personId = ?",
            params: [effectivePersonId],
          },
        ]);
      }
      this.invalidateFaceClusterPCACache();
      return true;
    }

    await this.db.transaction([
      {
        sql: "UPDATE faceClusters SET personId = ? WHERE id = ?",
        params: [effectivePersonId, effectivePersonId],
      },
      {
        sql: "UPDATE faceClusters SET name = ? WHERE id = ?",
        params: [normalizedName, effectivePersonId],
      },
      {
        sql: "UPDATE faceClusters SET name = NULL WHERE personId = ? AND id != ?",
        params: [effectivePersonId, effectivePersonId],
      },
    ]);

    this.invalidateFaceClusterPCACache();
    return true;
  }

  async mergeClusters(
    sourceClusterId: string,
    targetClusterId: string,
  ): Promise<boolean> {
    const sourceId = faceClusterIdFromString(sourceClusterId);
    const targetId = faceClusterIdFromString(targetClusterId);
    if (sourceId === null || targetId === null || sourceId <= 0 || targetId <= 0)
      return false;
    if (sourceId === targetId) return false;

    const [sourceRow, targetRow] = await Promise.all([
      this.db.get<{ id: number; personId: number | null }>(
        "SELECT id, personId FROM faceClusters WHERE id = ?",
        sourceId,
      ),
      this.db.get<{ id: number; personId: number | null }>(
        "SELECT id, personId FROM faceClusters WHERE id = ?",
        targetId,
      ),
    ]);
    if (!sourceRow || !targetRow) return false;

    const sourcePersonId = sourceRow.personId ?? sourceRow.id;
    const targetPersonId = targetRow.personId ?? targetRow.id;
    if (sourcePersonId === targetPersonId) return false;

    const [sourcePersonRow, targetPersonRow] = await Promise.all([
      this.db.get<{ name: string | null }>(
        "SELECT name FROM faceClusters WHERE id = ?",
        sourcePersonId,
      ),
      this.db.get<{ name: string | null }>(
        "SELECT name FROM faceClusters WHERE id = ?",
        targetPersonId,
      ),
    ]);

    const canonicalTargetId =
      targetPersonRow?.name == null && sourcePersonRow?.name != null
        ? sourcePersonId
        : targetPersonId;
    const movedPersonId =
      canonicalTargetId === sourcePersonId ? targetPersonId : sourcePersonId;
    const movedClusterRows = await this.db.all<{ id: number }>(
      `SELECT id FROM faceClusters
       WHERE id = ? OR personId = ?`,
      movedPersonId,
      movedPersonId,
    );
    if (movedClusterRows.length === 0) return false;

    const placeholders = movedClusterRows.map(() => "?").join(", ");
    await this.db.transaction([
      {
        sql: "UPDATE faceClusters SET personId = ? WHERE id = ?",
        params: [canonicalTargetId, canonicalTargetId],
      },
      {
        sql: `UPDATE faceClusters
              SET personId = ?, name = NULL
              WHERE id IN (${placeholders})`,
        params: [canonicalTargetId, ...movedClusterRows.map((row) => row.id)],
      },
      {
        sql: "UPDATE faceClusters SET name = NULL WHERE personId = ? AND id != ?",
        params: [canonicalTargetId, canonicalTargetId],
      },
    ]);

    // Rescore the moved sub-clusters' faces against the person's canonical
    // centroid so the merged person's clusterSimilarity values share one scale;
    // otherwise each moved sub-cluster's seed stays pinned at 1.0 and dominates
    // the person's representative/detail order with an arbitrary face. The
    // canonical cluster's own faces are already scored against this centroid.
    await this.faceClusters.rescoreFacesAgainstCluster(
      canonicalTargetId,
      movedClusterRows.map((row) => row.id),
    );

    this.invalidateFaceClusterPCACache();
    return true;
  }

  async separateCluster(clusterId: string): Promise<boolean> {
    const numericId = faceClusterIdFromString(clusterId);
    if (numericId === null || numericId <= 0) return false;

    const clusterRow = await this.db.get<{ id: number; personId: number | null }>(
      "SELECT id, personId FROM faceClusters WHERE id = ?",
      numericId,
    );
    if (
      !clusterRow ||
      clusterRow.personId === null ||
      clusterRow.personId === clusterRow.id
    ) {
      return false;
    }

    await this.db.run(
      "UPDATE faceClusters SET personId = NULL, name = NULL WHERE id = ?",
      clusterRow.id,
    );

    // The cluster is a standalone person again; restore self-scoring so its
    // similarities are relative to its own centroid rather than the former
    // person's canonical one (set when it was merged in).
    await this.faceClusters.rescoreFacesAgainstCluster(clusterRow.id, [clusterRow.id]);

    this.invalidateFaceClusterPCACache();
    return true;
  }

  /**
   * Sets (replacing) the tag list for the person a cluster resolves to.
   * Mirrors renameCluster's root-resolution: tags always live on the person
   * root row (id = COALESCE(personId, id)), never on a merged-in member, so
   * they survive future merges/separations the same way `name` does.
   */
  async setClusterTags(clusterId: string, tags: string[]): Promise<boolean> {
    const numericId = faceClusterIdFromString(clusterId);
    if (numericId === null || numericId <= 0) return false;

    const clusterRow = await this.db.get<{ id: number; personId: number | null }>(
      "SELECT id, personId FROM faceClusters WHERE id = ?",
      numericId,
    );
    if (!clusterRow) return false;

    const effectivePersonId = clusterRow.personId ?? clusterRow.id;
    const normalized = [
      ...new Set(tags.map((t) => t.trim()).filter((t) => t.length > 0)),
    ];
    await this.db.run(
      "UPDATE faceClusters SET tags = ? WHERE id = ?",
      normalized.length > 0 ? JSON.stringify(normalized) : null,
      effectivePersonId,
    );
    return true;
  }

  /** Distinct tags across every named/tagged person, for filter-panel suggestions. */
  async getAllPersonTags(): Promise<string[]> {
    const rows = await this.db.all<{ tags: string }>(
      "SELECT tags FROM faceClusters WHERE tags IS NOT NULL",
    );
    const all = new Set<string>();
    for (const row of rows) {
      // Only setClusterTags writes this column, so a parse failure is a bug:
      // log it, but don't fail a suggestions query over it.
      const parsed = attemptSync(() => JSON.parse(row.tags) as unknown[]);
      if (!parsed.ok) {
        log.warn({ err: parsed.error }, "Unreadable person tags");
        continue;
      }
      for (const tag of parsed.value) {
        if (typeof tag === "string") all.add(tag);
      }
    }
    return [...all].sort();
  }

  /**
   * Feedback #90: pulls one outlier detection out of the cluster it's
   * currently in. `faceId` must still belong to a real cluster (`clusterId >
   * 0`) — a face already excluded, low-confidence, or unclusterable is a
   * no-op (`false`). See FaceClusterEngine.excludeFace for the centroid math
   * and the sentinel/exclusion-record write.
   */
  async excludeFaceFromCluster(faceId: number): Promise<boolean> {
    const applied = await this.setFaceVerdicts([faceId], "rejected");
    return applied > 0;
  }

  /**
   * Centroids of every cluster that resolves to a *named* person — the lookup
   * table for matching a face from outside the library (a doorbell frame, an
   * uploaded snap) against people already identified in the People tab.
   *
   * One row per cluster, not per person: merging carries the name on the person
   * root rather than copying it onto each member, so a person can own several
   * centroids (a beard year, a childhood). Keeping them separate means a live
   * face only has to resemble one of a person's looks rather than their average
   * across all of them; callers collapse by name.
   */
  async getNamedFaceCentroids(): Promise<
    Array<{ clusterId: number; name: string; centroid: Buffer }>
  > {
    const rows = await this.db.all<{ id: number; name: string; centroid: Buffer }>(
      `SELECT
         faceClusters.id AS id,
         COALESCE(personRoots.name, faceClusters.name) AS name,
         faceClusters.centroid AS centroid
       FROM faceClusters
       LEFT JOIN faceClusters AS personRoots
         ON personRoots.id = faceClusters.personId
       WHERE faceClusters.weight > 0
         AND COALESCE(personRoots.name, faceClusters.name) IS NOT NULL`,
    );
    return rows.map((row) => ({
      clusterId: row.id,
      name: row.name,
      centroid: row.centroid,
    }));
  }

  /** Cheap index-only counts — polled by the backfill task's status hook. */
  async getFaceClusteringProgress(): Promise<{ assigned: number; pending: number }> {
    const [assignedRow, pendingRow] = await Promise.all([
      this.db.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM faces WHERE clusterId > 0",
      ),
      this.db.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM faces WHERE clusterId IS NULL",
      ),
    ]);
    return { assigned: assignedRow?.count ?? 0, pending: pendingRow?.count ?? 0 };
  }

  // ===== Face cluster review and repair =====
  // The user-facing half of clustering: finding the faces that don't belong in
  // a person's group and getting them out. See faceReview.ts for the scoring
  // and planning logic (pure, unit-tested) and faceClusterEngine.ts for the
  // verdict/anchor/radius machinery this drives.

  /**
   * Resolves any of a person's centroid ids to their canonical root plus every
   * centroid they own. Merges mean a person is a *set* of clusters, and every
   * review operation has to address all of them — a cutoff written onto only
   * the root would leave the other centroids accepting faces freely.
   */
  private async resolvePersonClusters(
    clusterId: string,
  ): Promise<{ root: number; members: number[] } | null> {
    const numericId = faceClusterIdFromString(clusterId);
    if (numericId === null) return null;
    const row = await this.db.get<{ id: number; personId: number | null }>(
      "SELECT id, personId FROM faceClusters WHERE id = ?",
      numericId,
    );
    if (!row) return null;
    const root = row.personId ?? row.id;
    const members = await this.db.all<{ id: number }>(
      "SELECT id FROM faceClusters WHERE id = ? OR personId = ?",
      root,
      root,
    );
    return { root, members: members.map((member) => member.id) };
  }

  /**
   * Everything the review UI needs about one person, in one round trip.
   *
   * Faces come back ordered by similarity to the person's *reference* vector —
   * their anchor if they have one, the running centroid otherwise — because
   * that ordering is what makes a single cut line able to remove a whole tail
   * of intruders at once. Each face also carries its independent anomaly
   * signals (date, location, folder), which catch the case similarity cannot: a
   * genuine look-alike sitting comfortably inside the band.
   *
   * Already-rejected faces are returned too, in their own list, so the UI can
   * show what was removed and offer it back. A correction tool that hides its
   * own past corrections is one the user can't audit or undo.
   */
  async getFaceClusterReview(clusterId: string): Promise<FaceReviewResult | null> {
    const resolved = await this.resolvePersonClusters(clusterId);
    if (!resolved) return null;
    const { root, members } = resolved;

    const reference = await this.faceClusters.getReferenceVector(members);
    const meta = await this.db.get<{ name: string | null; radius: number | null; anchorCount: number | null }>(
      "SELECT name, radius, anchorCount FROM faceClusters WHERE id = ?",
      root,
    );

    const placeholders = members.map(() => "?").join(", ");
    const rows = await this.db.all<{
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
      dateTaken: number | null;
      latitude: number | null;
      longitude: number | null;
      embedding: Buffer | null;
      verdict: FaceVerdict | null;
    }>(
      `SELECT f.id AS id, f.folder AS folder, f.fileName AS fileName,
              f.boxX AS boxX, f.boxY AS boxY, f.boxWidth AS boxWidth,
              f.boxHeight AS boxHeight,
              f.frameTimeMs AS frameTimeMs,
              files.mimeType AS mimeType,
              files.dimensionsWidth AS dimensionWidth,
              files.dimensionsHeight AS dimensionHeight,
              files.regions AS regions,
              files.dateTaken AS dateTaken,
              files.locationLatitude AS latitude,
              files.locationLongitude AS longitude,
              fe.embedding AS embedding,
              v.verdict AS verdict
       FROM faces f
       JOIN files ON files.folder = f.folder AND files.fileName = f.fileName
       LEFT JOIN faceEmbeddings fe ON fe.faceId = f.id
       LEFT JOIN faceVerdicts v ON v.faceId = f.id
       WHERE f.clusterId IN (${placeholders})
          OR (v.verdict = 'rejected' AND v.personId = ?)`,
      ...members,
      root,
    );

    const scored = rows.map((row) => {
      const unit = row.embedding ? toUnitFloat32(row.embedding) : null;
      const similarity =
        unit && reference ? dotProduct(unit, reference.vector) : Number.NaN;
      return { row, similarity };
    });

    const anomalyInputs: AnomalyInput[] = scored
      .filter(({ row }) => row.verdict !== "rejected")
      .map(({ row, similarity }) => ({
        faceId: row.id,
        similarity: Number.isNaN(similarity) ? 1 : similarity,
        takenAt: row.dateTaken,
        latitude: row.latitude,
        longitude: row.longitude,
        folder: row.folder,
      }));
    const anomalies = new Map(
      scoreAnomalies(anomalyInputs).map((result) => [result.faceId, result]),
    );

    const toReviewFace = ({
      row,
      similarity,
    }: (typeof scored)[number]): FaceReviewFace => {
      const anomaly = anomalies.get(row.id);
      return {
        ...faceRowToClusterFace(row),
        similarity: Number.isNaN(similarity) ? null : similarity,
        verdict: row.verdict,
        anomalyScore: anomaly?.score ?? 0,
        flags: anomaly?.flags ?? [],
        reasons: anomaly?.reasons ?? [],
      };
    };

    const bySimilarityDescending = (a: FaceReviewFace, b: FaceReviewFace) =>
      (b.similarity ?? -Infinity) - (a.similarity ?? -Infinity);

    const faces = scored
      .filter(({ row }) => row.verdict !== "rejected")
      .map(toReviewFace)
      .sort(bySimilarityDescending);
    const rejected = scored
      .filter(({ row }) => row.verdict === "rejected")
      .map(toReviewFace)
      .sort(bySimilarityDescending);

    return {
      personId: faceClusterIdToString(root),
      name: meta?.name ?? null,
      anchored: reference?.anchored ?? false,
      anchorCount: meta?.anchorCount ?? 0,
      radius: meta?.radius ?? null,
      faces,
      rejected,
      suggestedCutoff: suggestCutoff(
        faces
          .map((face) => face.similarity)
          .filter((value): value is number => value !== null),
      ),
    };
  }

  /**
   * Applies a cut line: everything below `threshold` leaves the person, and the
   * threshold is remembered as their radius so it keeps holding on future scans.
   *
   * Two deliberate asymmetries:
   *
   * - **A confirmed face is never cut.** The user has personally vouched for it,
   *   and a slider must not be able to silently overrule that. It is also the
   *   safety valve that makes dragging the line exploratory rather than
   *   dangerous.
   * - **`dryRun` reports without acting**, so the UI can put a real count
   *   ("removes 14 faces") behind the button instead of asking the user to
   *   guess what a cosine threshold means.
   */
  async applyFaceClusterCutoff(
    clusterId: string,
    threshold: number,
    options: { dryRun?: boolean } = {},
  ): Promise<{ affected: number; faceIds: number[] } | null> {
    const resolved = await this.resolvePersonClusters(clusterId);
    if (!resolved) return null;
    const review = await this.getFaceClusterReview(clusterId);
    if (!review) return null;

    const doomed = review.faces.filter(
      (face) =>
        face.verdict !== "confirmed" &&
        face.similarity !== null &&
        face.similarity < threshold,
    );
    const faceIds = doomed.map((face) => face.faceId);
    if (options.dryRun) return { affected: faceIds.length, faceIds };

    if (faceIds.length) await this.setFaceVerdicts(faceIds, "rejected");
    await this.faceClusters.setRadius(resolved.members, threshold);
    this.invalidateFaceClusterPCACache();
    return { affected: faceIds.length, faceIds };
  }

  /** Clears a person's radius, re-opening them to any face above the global threshold. */
  async clearFaceClusterRadius(clusterId: string): Promise<boolean> {
    const resolved = await this.resolvePersonClusters(clusterId);
    if (!resolved) return false;
    await this.faceClusters.setRadius(resolved.members, null);
    return true;
  }

  /**
   * Records (or with `null`, withdraws) the user's verdict on specific faces.
   *
   * This is the "tag this face in or out by hand" primitive that the cutoff,
   * the viewer's per-face correction and the review UI's keyboard queue all
   * funnel into, so there is exactly one place where a manual judgement is
   * written. Returns how many faces it actually acted on — a face that is
   * already excluded, unclusterable or missing an embedding is skipped rather
   * than failing the whole batch, since these arrive in bulk from a multi-select.
   */
  async setFaceVerdicts(
    faceIds: number[],
    verdict: FaceVerdict | null,
  ): Promise<number> {
    if (!faceIds.length) return 0;

    if (verdict === null) {
      await this.faceClusters.clearVerdicts(faceIds);
      this.invalidateFaceClusterPCACache();
      return faceIds.length;
    }

    const placeholders = faceIds.map(() => "?").join(", ");
    const rows = await this.db.all<{
      id: number;
      clusterId: number | null;
      personId: number | null;
      embedding: Buffer | null;
    }>(
      `SELECT f.id AS id, f.clusterId AS clusterId,
              COALESCE(fc.personId, f.clusterId) AS personId,
              fe.embedding AS embedding
       FROM faces f
       LEFT JOIN faceClusters fc ON fc.id = f.clusterId
       LEFT JOIN faceEmbeddings fe ON fe.faceId = f.id
       WHERE f.id IN (${placeholders})`,
      ...faceIds,
    );

    const eligible = rows.filter(
      (row) => row.clusterId !== null && row.clusterId > 0 && row.personId !== null,
    );
    if (!eligible.length) return 0;

    if (verdict === "confirmed") {
      await this.faceClusters.confirmFaces(
        eligible.map((row) => ({
          id: row.id,
          clusterId: row.clusterId!,
          personId: row.personId!,
        })),
      );
    } else {
      const withEmbedding = eligible.filter((row) => row.embedding);
      if (!withEmbedding.length) return 0;
      await this.faceClusters.rejectFaces(
        withEmbedding.map((row) => ({
          id: row.id,
          clusterId: row.clusterId!,
          personId: row.personId!,
          embedding: row.embedding!,
        })),
      );
      this.invalidateFaceClusterPCACache();
      return withEmbedding.length;
    }

    this.invalidateFaceClusterPCACache();
    return eligible.length;
  }

  /**
   * Discards every cluster assignment so the backfill re-derives them from
   * scratch. Manual verdicts survive and are re-applied once it drains — see
   * FaceClusterEngine.resetAssignments.
   *
   * Not exposed over HTTP: on a library this size it is minutes of background
   * work and it invalidates every person's centroid, so it belongs behind a
   * deliberate operator action rather than a button.
   */
  async resetFaceClusterAssignments(): Promise<void> {
    await this.faceClusters.resetAssignments();
    this.invalidateFaceClusterPCACache();
  }

  /**
   * Re-asserts stored verdicts after the clustering backfill drains. See
   * FaceClusterEngine.reapplyVerdicts — this is what makes a manual correction
   * outlive a library-wide re-cluster.
   */
  async reapplyFaceVerdicts(): Promise<number> {
    const reapplied = await this.faceClusters.reapplyVerdicts();
    if (reapplied) this.invalidateFaceClusterPCACache();
    return reapplied;
  }

  /**
   * A dry-run repair plan for the whole library: people to merge, people to
   * tighten with a radius.
   *
   * Nothing is applied. The proposals come back with their evidence so the user
   * decides each one — automatic merging is exactly how two similar relatives
   * become one unusable cluster, and undoing that by hand is far more work than
   * confirming a list.
   *
   * Only clusters with at least `minWeight` members are considered. A library
   * this size has tens of thousands of one- and two-face clusters; they are
   * noise, the backfill absorbs them as more photos arrive, and including them
   * would make the pairwise scan quadratic in the wrong number.
   */
  async planFaceClusterOptimization(
    options: { minWeight?: number; maxProposals?: number } = {},
  ): Promise<OptimizeProposal[]> {
    const minWeight = options.minWeight ?? 5;

    const clusterRows = await this.db.all<{
      id: number;
      personId: number | null;
      name: string | null;
      rootName: string | null;
      centroid: Buffer;
      anchorCentroid: Buffer | null;
      anchorCount: number | null;
      weight: number;
    }>(
      `SELECT fc.id AS id, fc.personId AS personId, fc.name AS name,
              roots.name AS rootName,
              fc.centroid AS centroid, fc.anchorCentroid AS anchorCentroid,
              fc.anchorCount AS anchorCount, fc.weight AS weight
       FROM faceClusters fc
       LEFT JOIN faceClusters AS roots ON roots.id = fc.personId
       WHERE fc.weight >= ? OR fc.name IS NOT NULL OR roots.name IS NOT NULL`,
      minWeight,
    );

    const similarityRows = await this.db.all<{ personId: number; similarity: number }>(
      `SELECT COALESCE(fc.personId, f.clusterId) AS personId,
              f.clusterSimilarity AS similarity
       FROM faces f
       JOIN faceClusters fc ON fc.id = f.clusterId
       WHERE f.clusterId > 0 AND f.clusterSimilarity IS NOT NULL`,
    );
    const similaritiesByPerson = new Map<number, number[]>();
    for (const row of similarityRows) {
      const list = similaritiesByPerson.get(row.personId);
      if (list) list.push(row.similarity);
      else similaritiesByPerson.set(row.personId, [row.similarity]);
    }

    // Fold each person's centroids into one vector, preferring anchors for the
    // same reason the review view does: a person with confirmed faces has a
    // reference the intruders haven't moved.
    const accumulators = new Map<
      number,
      { sum: Float32Array; name: string | null; count: number; anchored: boolean }
    >();
    for (const row of clusterRows) {
      const personId = row.personId ?? row.id;
      const anchor = row.anchorCentroid ? toAlignedFloat32(row.anchorCentroid) : null;
      // Both columns hold raw Float32 written by the engine — read them with
      // toAlignedFloat32, never decodeEmbedding/toUnitFloat32, which is for the
      // int8-encoded vectors in faceEmbeddings and would silently misread the
      // blob's length as a different dimension.
      const vector = anchor ?? toAlignedFloat32(row.centroid);
      if (!vector.length) continue;
      const scale = anchor ? (row.anchorCount ?? 1) : row.weight;

      let accumulator = accumulators.get(personId);
      if (!accumulator) {
        accumulator = {
          sum: new Float32Array(vector.length),
          name: row.rootName ?? row.name,
          count: 0,
          anchored: false,
        };
        accumulators.set(personId, accumulator);
      }
      // Once any centroid of a person is anchored, the un-anchored ones stop
      // contributing — mixing them back in restores the drift.
      if (anchor && !accumulator.anchored) {
        accumulator.sum.fill(0);
        accumulator.anchored = true;
      } else if (!anchor && accumulator.anchored) {
        accumulator.count += row.weight;
        continue;
      }
      for (let i = 0; i < vector.length; i += 1) accumulator.sum[i] += vector[i] * scale;
      accumulator.count += row.weight;
      accumulator.name ??= row.rootName ?? row.name;
    }

    const clusters: OptimizeCluster[] = [];
    for (const [personId, accumulator] of accumulators) {
      let magnitudeSquared = 0;
      for (let i = 0; i < accumulator.sum.length; i += 1) {
        magnitudeSquared += accumulator.sum[i] * accumulator.sum[i];
      }
      const magnitude = Math.sqrt(magnitudeSquared);
      if (!magnitude) continue;
      const vector = new Float32Array(accumulator.sum.length);
      for (let i = 0; i < vector.length; i += 1) vector[i] = accumulator.sum[i] / magnitude;

      clusters.push({
        id: faceClusterIdToString(personId),
        name: accumulator.name,
        count: accumulator.count,
        vector,
        similarities: (similaritiesByPerson.get(personId) ?? []).sort((a, b) => b - a),
      });
    }

    return await planOptimization(clusters, {
      ...(options.maxProposals !== undefined ? { maxProposals: options.maxProposals } : {}),
    });
  }

  // ===== Cluster geometry: refit, grow, shrink =====
  // A cluster is a centre and a distance (faceGeometry.ts's `Cap`). These are
  // the three ways that shape changes in response to a correction.

  /** Member faces of a cluster, with their decoded unit vectors. */
  private async loadClusterVectors(
    clusterIds: number[],
  ): Promise<Array<{ faceId: number; vector: Float32Array }>> {
    if (!clusterIds.length) return [];
    const rows = await this.db.all<{ id: number; embedding: Buffer }>(
      `SELECT f.id AS id, fe.embedding AS embedding
       FROM faces f
       JOIN faceEmbeddings fe ON fe.faceId = f.id
       WHERE f.clusterId IN (${clusterIds.map(() => "?").join(", ")})`,
      ...clusterIds,
    );
    return rows.flatMap((row) => {
      const vector = toUnitFloat32(row.embedding);
      return vector ? [{ faceId: row.id, vector }] : [];
    });
  }

  /** Vectors of the faces the user has rejected from this person. */
  private async loadRejectedVectors(personId: number): Promise<Float32Array[]> {
    const rows = await this.db.all<{ embedding: Buffer }>(
      `SELECT fe.embedding AS embedding
       FROM faceVerdicts v
       JOIN faceEmbeddings fe ON fe.faceId = v.faceId
       WHERE v.verdict = 'rejected' AND v.personId = ?`,
      personId,
    );
    return rows.flatMap((row) => {
      const vector = toUnitFloat32(row.embedding);
      return vector ? [vector] : [];
    });
  }

  private async loadFaceVector(faceId: number): Promise<Float32Array | null> {
    const row = await this.db.get<{ embedding: Buffer }>(
      "SELECT embedding FROM faceEmbeddings WHERE faceId = ?",
      faceId,
    );
    return row?.embedding ? toUnitFloat32(row.embedding) : null;
  }

  /**
   * Re-derives a cluster's centre and radius from the members it actually has,
   * splitting it when one cap cannot hold them without also covering a face the
   * user rejected.
   *
   * Grow and shrink only ever push the boundary around a centre fixed long ago;
   * after a few corrections that centre describes the cluster's history rather
   * than its contents. This is what gives the slack back, and it is why an edit
   * path should refit once it settles.
   */
  async refitFaceCluster(
    clusterId: string,
  ): Promise<{ caps: number; uncovered: number; clusterIds: string[] } | null> {
    const resolved = await this.resolvePersonClusters(clusterId);
    const numericId = faceClusterIdFromString(clusterId);
    if (!resolved || numericId === null) return null;

    const members = await this.loadClusterVectors([numericId]);
    if (!members.length) return null;
    const avoid = await this.loadRejectedVectors(resolved.root);

    const { caps, uncovered } = refitCaps(members, avoid);
    if (!caps.length) return { caps: 0, uncovered: uncovered.length, clusterIds: [] };

    const usedIds = await this.faceClusters.applyRefit(
      numericId,
      caps.map((fitted) => ({
        centre: fitted.cap.centre,
        minSimilarity: fitted.cap.minSimilarity,
        faceIds: fitted.faceIds,
      })),
    );

    // Caps beyond the first are new clusters; attach them to the same person so
    // a split reads as "one more look", not as a stranger appearing.
    const created = usedIds.slice(1);
    if (created.length) {
      await this.db.transaction(
        created.map((id) => ({
          sql: "UPDATE faceClusters SET personId = ? WHERE id = ?",
          params: [resolved.root, id] as unknown[],
        })),
      );
    }

    this.invalidateFaceClusterPCACache();
    return {
      caps: usedIds.length,
      uncovered: uncovered.length,
      clusterIds: usedIds.map(faceClusterIdToString),
    };
  }

  /**
   * Tightens whichever of a person's caps currently reach `faceId`, just enough
   * to put it outside, and reports everything else that leaves with it.
   *
   * A cap can only exclude from the outside in, so this cannot remove a face
   * sitting *closer* to a centre than members being kept — `collateral` makes
   * that visible (it comes back large) so the caller can fall back to an
   * explicit rejection instead of silently gutting the cluster.
   */
  async shrinkToExcludeFace(
    clusterId: string,
    faceId: number,
    options: { dryRun?: boolean } = {},
  ): Promise<{
    affected: number;
    excludable: boolean;
    sample: FaceClusterFace[];
    faceIds: number[];
  } | null> {
    const resolved = await this.resolvePersonClusters(clusterId);
    if (!resolved) return null;
    const target = await this.loadFaceVector(faceId);
    if (!target) return null;

    const members = await this.loadClusterVectors(resolved.members);
    const byCluster = new Map<number, Array<{ faceId: number; vector: Float32Array }>>();
    const memberClusterRows = await this.db.all<{ id: number; clusterId: number }>(
      `SELECT id, clusterId FROM faces WHERE clusterId IN (${resolved.members
        .map(() => "?")
        .join(", ")})`,
      ...resolved.members,
    );
    const clusterOfFace = new Map(memberClusterRows.map((r) => [r.id, r.clusterId]));
    for (const member of members) {
      const owner = clusterOfFace.get(member.faceId);
      if (owner === undefined) continue;
      const list = byCluster.get(owner);
      if (list) list.push(member);
      else byCluster.set(owner, [member]);
    }

    const updates: Array<{ clusterId: number; minSimilarity: number }> = [];
    const evicted = new Set<number>();

    for (const memberClusterId of resolved.members) {
      const cap = await this.faceClusters.getCap(memberClusterId);
      if (!cap) continue;
      // Only caps that currently reach the face need to move.
      if (capDot(target, cap.centre) < cap.minSimilarity) continue;

      const floor = shrinkCapToExclude(cap, target);
      updates.push({ clusterId: memberClusterId, minSimilarity: floor });
      for (const leaving of collateralOf(cap, floor, byCluster.get(memberClusterId) ?? [])) {
        evicted.add(leaving.faceId);
      }
    }

    const faceIds = [...evicted];
    const sample = faceIds.length ? await this.getFacesByIds(faceIds.slice(0, 12)) : [];
    const result = {
      affected: faceIds.length,
      // False when the face is interior to every cap that holds it: tightening
      // would take the cluster with it, so a rejection is the right tool.
      excludable: updates.length > 0,
      sample,
      faceIds,
    };
    if (options.dryRun || !updates.length) return result;

    await this.faceClusters.applyShrink(updates, faceIds);
    this.invalidateFaceClusterPCACache();
    return result;
  }

  /**
   * Widens a cluster towards `faceId` so it belongs, and reports which faces
   * that are *not* this person's would end up inside the widened cap.
   *
   * The widening moves the centre towards the new face rather than inflating in
   * place, so the far side of the cluster does not sweep outwards — see
   * faceGeometry.growCapToInclude. The collateral scan runs inside SQLite via
   * `cosine_similarity_i8` rather than pulling 365k vectors onto the JS heap.
   */
  async growToIncludeFace(
    clusterId: string,
    faceId: number,
    options: { dryRun?: boolean; includeCollateral?: boolean } = {},
  ): Promise<{
    affected: number;
    sample: FaceClusterFace[];
    faceIds: number[];
  } | null> {
    const resolved = await this.resolvePersonClusters(clusterId);
    const numericId = faceClusterIdFromString(clusterId);
    if (!resolved || numericId === null) return null;
    const target = await this.loadFaceVector(faceId);
    if (!target) return null;
    const cap = await this.faceClusters.getCap(numericId);
    if (!cap) return null;

    const grown: Cap = growCapToInclude(cap, target);
    const query = encodeEmbedding(grown.centre);
    if (!query) return null;

    const ownClusters = resolved.members.map(() => "?").join(", ");
    const collateralRows = await this.db.all<{ id: number }>(
      `SELECT f.id AS id
       FROM faces f
       JOIN faceEmbeddings fe ON fe.faceId = f.id
       WHERE f.id != ?
         AND (f.clusterId IS NULL OR f.clusterId > 0)
         AND (f.clusterId IS NULL OR f.clusterId NOT IN (${ownClusters}))
         AND cosine_similarity_i8(fe.embedding, ?) >= ?`,
      faceId,
      ...resolved.members,
      query,
      grown.minSimilarity,
    );

    const faceIds = collateralRows.map((row) => row.id);
    const sample = faceIds.length ? await this.getFacesByIds(faceIds.slice(0, 12)) : [];
    const result = { affected: faceIds.length, sample, faceIds };
    if (options.dryRun) return result;

    const moving = options.includeCollateral ? [faceId, ...faceIds] : [faceId];
    await this.faceClusters.applyGrow(numericId, grown, moving);
    this.invalidateFaceClusterPCACache();
    return result;
  }

  /**
   * Puts one face in a cluster of its own under the same person — the answer
   * when growing an existing cap would have cost too much.
   */
  async startClusterForFace(
    clusterId: string,
    faceId: number,
  ): Promise<{ clusterId: string } | null> {
    const resolved = await this.resolvePersonClusters(clusterId);
    if (!resolved) return null;
    const vector = await this.loadFaceVector(faceId);
    if (!vector) return null;

    const cap = minimalEnclosingCap([vector]);
    if (!cap) return null;
    // A single face gives a zero-radius cap, which nothing could ever join.
    // Open it to the library-wide default so the cluster can actually grow.
    const created = await this.faceClusters.createCluster(
      { centre: cap.centre, minSimilarity: FACE_CLUSTER_SIMILARITY_THRESHOLD },
      [faceId],
    );
    await this.db.transaction([
      {
        sql: "UPDATE faceClusters SET personId = ? WHERE id = ?",
        params: [resolved.root, created],
      },
    ]);
    this.invalidateFaceClusterPCACache();
    return { clusterId: faceClusterIdToString(created) };
  }

  /** Face crops for a set of face ids, for previewing what a change implicates. */
  private async getFacesByIds(faceIds: number[]): Promise<FaceClusterFace[]> {
    if (!faceIds.length) return [];
    const rows = await this.db.all<{
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
    }>(
      `SELECT f.id AS id, f.folder AS folder, f.fileName AS fileName,
              f.boxX AS boxX, f.boxY AS boxY, f.boxWidth AS boxWidth,
              f.boxHeight AS boxHeight,
              f.frameTimeMs AS frameTimeMs,
              files.mimeType AS mimeType,
              files.dimensionsWidth AS dimensionWidth,
              files.dimensionsHeight AS dimensionHeight,
              files.regions AS regions
       FROM faces f
       JOIN files ON files.folder = f.folder AND files.fileName = f.fileName
       WHERE f.id IN (${faceIds.map(() => "?").join(", ")})`,
      ...faceIds,
    );
    return rows.map(faceRowToClusterFace);
  }

  // ===== Moment clustering (burst / near-duplicate stacks) =====
  // See momentClusterEngine.ts for the algorithm this backs.

}
