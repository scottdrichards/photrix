import type { AsyncSqlite } from "../../common/asyncSqlite.ts";
import { filterToSQL } from "../../indexDatabase/filterToSQL.ts";
import type { FaceClusterCentroid, FaceClusterFace, QueryOptions } from "../../indexDatabase/indexDatabase.type.ts";
import { faceClusterIdFromString, faceClusterIdToString } from "./faceClusterId.ts";
import { faceRowToClusterFace } from "./faceRowToClusterFace.ts";
import { type ClusterDetailRow, videoFaceQuota, withVideoFaceShare } from "../clustering/clusterDetailVideoShare.ts";

/**
 * The steps behind PeopleQueries.getFaceClusterDetail, in the order it runs
 * them: resolve which faces the request is about, page them, give videos
 * their share past the cap, then the person's Match Groups.
 */

/** Which faces one detail request is about, and the filter they must pass. */
export type PersonDetailScope = {
  numericClusterId: number;
  effectivePersonId: number;
  isUnmerged: boolean;
  useDirectClusterFilter: boolean;
  faceScopeId: number;
  whereClause: string;
  whereParams: ReturnType<typeof filterToSQL>["params"];
};

/** null when the id is malformed or names no cluster. */
export const resolvePersonDetailScope = async (
  db: AsyncSqlite,
  clusterId: string,
  exactCluster: boolean,
  filter: QueryOptions["filter"],
): Promise<PersonDetailScope | null> => {
  const numericClusterId = faceClusterIdFromString(clusterId);
  if (numericClusterId === null || numericClusterId <= 0) {
    return null;
  }

  const clusterRow = await db.get<{ id: number; personId: number | null }>(
    "SELECT id, personId FROM faceClusters WHERE id = ?",
    numericClusterId,
  );
  if (!clusterRow) {
    return null;
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
  return {
    numericClusterId,
    effectivePersonId,
    isUnmerged,
    useDirectClusterFilter,
    faceScopeId,
    whereClause,
    whereParams,
  };
};

// Every query below starts from the person's own faces and checks each
// face's file against the filter, so its cost follows the person's size.
// It used to start from the files that pass the filter (MATERIALIZED +
// CROSS JOIN, the right shape for queryFaceClusters, which wants every
// cluster) and so paid for the whole library on every query: ~625 ms
// each, whatever the person's size. A filter is the normal case, not the
// exception — the standing default-exclusion filter (feedback #95)
// applies to every request — so a 27-face person's page took ~2.5 s.
// Person-first, the same counts take 3 ms (27 faces), 14 ms (1,420) and
// 107 ms (18,176).
//
// A merged person's clusters are resolved first and probed with IN; the
// COALESCE join over faceClusters walks every row (~130 ms) to find
// them. An unmerged cluster or an exactCluster request is one clusterId,
// which walks the by_cluster index in similarity order.
const scopedFaces = (scope: PersonDetailScope, direct: boolean, extra = "") =>
  `faces.clusterId > 0
       AND ${
         direct
           ? "faces.clusterId = ?"
           : `faces.clusterId IN (
                SELECT id FROM faceClusters WHERE COALESCE(personId, id) = ?
              )`
       }${extra}${
         scope.whereClause
           ? `
       AND EXISTS (
         SELECT 1 FROM files
         WHERE files.folder = faces.folder
           AND files.fileName = faces.fileName
           AND (${scope.whereClause})
       )`
           : ""
       }`;
const scopeParams = (scope: PersonDetailScope, scopeId: number) => [scopeId, ...scope.whereParams];

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

/** The top `limit` faces in scope, best match first. */
// The top-N face ids are picked inside the indexes, and only those N rows
// are then fetched with their file's columns.
export const selectPersonDetailRows = (
  db: AsyncSqlite,
  scope: PersonDetailScope,
  extra: string,
  limit: number,
) =>
  db.all<ClusterDetailRow>(
    `WITH limited AS (
           SELECT faces.id AS id
           FROM faces
           WHERE ${scopedFaces(scope, scope.useDirectClusterFilter, extra)}
           ORDER BY faces.clusterSimilarity DESC, faces.id
           LIMIT ${limit}
         )
         SELECT ${detailRowColumns}
         FROM limited
         JOIN faces
           ON faces.id = limited.id
         JOIN files
           ON files.folder = faces.folder
          AND files.fileName = faces.fileName
         ORDER BY faces.clusterSimilarity DESC, faces.id`,
    ...scopeParams(scope, scope.faceScopeId),
  );

export const countPersonDetailFaces = (db: AsyncSqlite, scope: PersonDetailScope, extra = "") =>
  db.get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM faces
         WHERE ${scopedFaces(scope, scope.useDirectClusterFilter, extra)}`,
    ...scopeParams(scope, scope.faceScopeId),
  );

/**
 * Feedback #153: past the cap, best-match-first starves video faces. A
 * face cut from a video frame is blurrier than a photo's and scores a
 * lower clusterSimilarity, so a person with 12% video faces got 1.6% of
 * the 2000 shown. Over the cap, give videos their proportional share,
 * taking the person's best-matching video faces. The list stays in
 * similarity order, which the client's "Best match" / "Least alike first"
 * sorts rely on. Only capped people pay for the two extra queries.
 */
export const withVideoShareWhenCapped = async (
  db: AsyncSqlite,
  scope: PersonDetailScope,
  rows: ClusterDetailRow[],
  cap: number,
  total: number,
): Promise<ClusterDetailRow[]> => {
  if (total > rows.length) {
    const videoOnly = "\n       AND faces.frameTimeMs IS NOT NULL";
    const videoCountRow = await countPersonDetailFaces(db, scope, videoOnly);
    const quota = videoFaceQuota(cap, total, videoCountRow?.count ?? 0);
    const shown = rows.filter((row) => row.frameTimeMs !== null).length;
    if (quota > shown) {
      return withVideoFaceShare(rows, await selectPersonDetailRows(db, scope, videoOnly, quota), cap);
    }
  }
  return rows;
};

/**
 * Match Groups: always the whole person (effectivePersonId), even for an
 * exactCluster request.
 */
export const loadPersonMatchGroups = async (
  db: AsyncSqlite,
  scope: PersonDetailScope,
): Promise<FaceClusterCentroid[]> => {
  const centroidAggregateRows = await db.all<{
    clusterId: number;
    count: number;
    id: number;
  }>(
    `SELECT
         faces.clusterId AS clusterId,
         COUNT(*) AS count,
         MAX(faces.clusterSimilarity) AS representativeSimilarity,
         faces.id AS id
       FROM faces
       WHERE ${scopedFaces(scope, scope.isUnmerged)}
       GROUP BY faces.clusterId
       ORDER BY COUNT(*) DESC, faces.clusterId`,
    ...scopeParams(scope, scope.effectivePersonId),
  );

  const centroidRepresentatives = new Map<number, FaceClusterFace>();
  if (centroidAggregateRows.length > 0) {
    const representativeRows = await db.all<{
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

  return centroidAggregateRows.flatMap((row) => {
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
};
