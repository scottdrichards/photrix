import { MIN_FACE_CLUSTER_SIZE, type FaceClusterLayout } from "./faceClusterLayout.ts";
import { AsyncSqlite } from "../../common/asyncSqlite.ts";
import { queryCacheKey, WriteInvalidatedCache } from "../../common/writeInvalidatedCache.ts";
import { filterToSQL } from "../../indexDatabase/filterToSQL.ts";
import { type FaceClusterDetailResult, type FaceClusterFace, type FaceClusterResult, type QueryOptions } from "../../indexDatabase/indexDatabase.type.ts";
import { attemptSync } from "../../common/result.ts";
import { faceClusterIdToString } from "./faceClusterId.ts";
import { faceRowToClusterFace } from "./faceRowToClusterFace.ts";
import {
  countPersonDetailFaces,
  loadPersonMatchGroups,
  resolvePersonDetailScope,
  selectPersonDetailRows,
  withVideoShareWhenCapped,
} from "./personDetail.ts";
import { getLogger } from "../../observability/logger.ts";

const log = getLogger("faceClusters");

// Caps the summary's cluster list (ordered by size, so this is "the 1000
// biggest people") and the detail's face list. Totals in the response still
// reflect the uncapped numbers. Without caps the summary JSON carried tens of
// thousands of clusters (megabytes) and a big person's detail tens of
// thousands of face entries.
const MAX_FACE_CLUSTERS_LISTED = 1000;

const MAX_FACES_IN_CLUSTER_DETAIL = 2000;

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

type FilterParams = ReturnType<typeof filterToSQL>["params"];

/** Reading people: the People list, one person's page, tags, named centroids and progress. */
export class PeopleQueries {
  // The People list for a filter, kept until the next write. Under the default
  // view's exclusion filter it costs about a second, and the People tab and the
  // face filter panel each ask for it again every time they open. Few entries:
  // one result is ~1.3 MB of JSON on the live library.
  private readonly peopleCache: WriteInvalidatedCache;

  constructor(
    private readonly db: AsyncSqlite,
    private readonly layout: FaceClusterLayout,
  ) {
    this.peopleCache = new WriteInvalidatedCache(() => this.db.writeGeneration, 8);
  }

  /** The result is shared between callers: treat it as read-only. */
  async queryFaceClusters(options: {
    filter: QueryOptions["filter"];
  }): Promise<FaceClusterResult> {
    const { where, params } = filterToSQL(options.filter);
    return this.peopleCache.get(queryCacheKey(`people\u0000${where}`, params), () =>
      this.computeFaceClusters(where, params),
    );
  }

  private async computeFaceClusters(
    whereClause: string,
    whereParams: FilterParams,
  ): Promise<FaceClusterResult> {
    // The two passes are independent reads, so they run side by side.
    const [aggregateRows, pendingRow] = await Promise.all([
      this.aggregatePeople(whereClause, whereParams),
      this.countPendingFaces(whereClause, whereParams),
    ]);

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

  private async aggregatePeople(
    whereClause: string,
    whereParams: FilterParams,
  ): Promise<{ personId: number; count: number; id: number }[]> {
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
    return aggregateRows;
  }

  private countPendingFaces(
    whereClause: string,
    whereParams: FilterParams,
  ): Promise<{ count: number } | undefined> {
    // Same join-order forcing as above. Only faces that pass the clusterId IS
    // NULL index constraint get a row fetch (for the LENGTH check), so the
    // BLOB drag is limited to the actual pending backlog. Without a filter the
    // needing_cluster partial index answers the count directly.
    return whereClause
      ? this.db.get<{ count: number }>(
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
      : this.db.get<{ count: number }>(
          `SELECT COUNT(*) AS count FROM faces WHERE clusterId IS NULL`,
        );
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
    const scope = await resolvePersonDetailScope(this.db, clusterId, exactCluster, filter);
    if (!scope) {
      return { cluster: null };
    }

    let rows = await selectPersonDetailRows(this.db, scope, "", cap);

    if (!rows.length) {
      return { cluster: null };
    }

    // `count` reflects the whole cluster within the filter even when the faces
    // list is capped.
    const countRow = await countPersonDetailFaces(this.db, scope);
    const total = countRow?.count ?? rows.length;
    rows = await withVideoShareWhenCapped(this.db, scope, rows, cap, total);

    const faces = rows.map(faceRowToClusterFace);
    const nameRow = await this.db.get<{ name: string | null; tags: string | null }>(
      "SELECT name, tags FROM faceClusters WHERE id = ?",
      scope.effectivePersonId,
    );

    const centroids = await loadPersonMatchGroups(this.db, scope);

    const mergeSuggestions = await this.layout.getMergeSuggestions(scope.effectivePersonId, filter);

    return {
      cluster: {
        id: faceClusterIdToString(scope.effectivePersonId),
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
}
