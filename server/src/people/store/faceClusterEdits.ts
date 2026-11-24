import type { FaceClusterLayout } from "./faceClusterLayout.ts";
import { AsyncSqlite } from "../../common/asyncSqlite.ts";
import { FaceClusterEngine, LOW_CONFIDENCE_CLUSTER_ID, MIN_FACE_CONFIDENCE_FOR_CLUSTERING, UNCLUSTERABLE_CLUSTER_ID } from "./faceClusterEngine.ts";
import { faceClusterIdFromString } from "./faceClusterId.ts";
import { getLogger } from "../../observability/logger.ts";

const log = getLogger("faceClusters");

// PRAGMA user_version marking that the one-time low-confidence face-cluster
// purge has run (see purgeLowConfidenceFaceClusters). Bump to re-run after a
// future change to the confidence floor.
const LOW_CONFIDENCE_PURGE_VERSION = 1;

// A cluster losing at least this fraction of its members to the confidence
// purge is treated as a junk hub: its confident survivors are freed for
// re-clustering rather than left behind under a junk-derived centroid.
const HUB_RECLUSTER_PURGE_FRACTION = 0.3;

// PRAGMA user_version marking that the one-time rescore of already-merged
// sub-clusters against their canonical centroid has run (see
// rescoreMergedClusterSimilarities). Runs after the purge, so it must sit above
// LOW_CONFIDENCE_PURGE_VERSION in this monotonically-increasing scheme.
const MERGED_SIMILARITY_RESCORE_VERSION = 2;

/** Writing people: draining the clustering backlog, one-time repairs, rename, merge, separate and tags. */
export class FaceClusterEdits {
  constructor(
    private readonly db: AsyncSqlite,
    private readonly faceClusters: FaceClusterEngine,
    private readonly layout: FaceClusterLayout,
  ) {}

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
    this.layout.invalidateFaceClusterPCACache();
    return idRows.length;
  }

  async pruneEmptyFaceClusters(): Promise<void> {
    await this.faceClusters.pruneEmptyClusters();
    this.layout.invalidateFaceClusterPCACache();
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
    this.layout.invalidateFaceClusterPCACache();
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
    this.layout.invalidateFaceClusterPCACache();
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
      this.layout.invalidateFaceClusterPCACache();
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

    this.layout.invalidateFaceClusterPCACache();
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

    this.layout.invalidateFaceClusterPCACache();
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

    this.layout.invalidateFaceClusterPCACache();
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
}
