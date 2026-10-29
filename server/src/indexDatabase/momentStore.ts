import { AsyncSqlite } from "../common/asyncSqlite.ts";
import { type MomentClusterDetail } from "./indexDatabase.type.ts";
import { pickRepresentative } from "./momentClusterEngine.ts";
import { splitPath } from "./utils/pathUtils.ts";
import { decodeEmbedding, encodeEmbedding } from "./embeddingCodec.ts";

/** Moment clusters: bursts and near-duplicates stacked into one grid tile. */
export class MomentStore {
  constructor(private readonly db: AsyncSqlite) {}

  /**
   * Next batch of images the moment-clustering task hasn't evaluated yet, in
   * capture-time order — the scan has to walk dateTaken order to chain
   * temporally-adjacent photos. Only images with a decodable CLIP embedding are
   * eligible (a photo with no embedding can never be compared, so it is left
   * unprocessed rather than force-included with no signal); it is retried
   * automatically once imageAnalysis embeds it, since that stage's onDrain
   * re-queues this one (see registerBackgroundTasks.ts).
   *
   * Newest-first (2026-08-12): the backlog is large enough (~192k photos)
   * that an oldest-first sweep left recent photos — the ones users actually
   * browse — unprocessed for days, even though clusters further back were
   * already forming correctly. Flipping the order here means the *next*
   * batch fetched is always the newest still-unprocessed slice, so results
   * show up in front of normal recent-photos browsing almost immediately.
   * Already-processed rows (regardless of when they were processed, or in
   * which direction) are untouched by this — they're simply excluded via
   * momentClusterProcessedAt IS NOT NULL, same as before. See
   * getMomentClusteringSweepSeedState for the matching change to how a
   * resumed run reconstructs chain continuity.
   */
  async getMomentClusteringBatch(
    limit: number,
  ): Promise<
    Array<{
      folder: string;
      fileName: string;
      dateTaken: number;
      embedding: Float32Array;
    }>
  > {
    const rows = await this.db.all<{
      folder: string;
      fileName: string;
      dateTaken: number;
      imageEmbedding: Buffer | null;
    }>(
      `SELECT files.folder, files.fileName, files.dateTaken, fileEmbeddings.imageEmbedding
       FROM files
       JOIN fileEmbeddings
         ON fileEmbeddings.folder = files.folder AND fileEmbeddings.fileName = files.fileName
       WHERE files.mimeType LIKE 'image/%'
         AND files.momentClusterProcessedAt IS NULL
         AND files.dateTaken IS NOT NULL
         AND fileEmbeddings.imageEmbedding IS NOT NULL
       ORDER BY files.dateTaken DESC, files.folder DESC, files.fileName DESC
       LIMIT ?`,
      limit,
    );

    const out: Array<{
      folder: string;
      fileName: string;
      dateTaken: number;
      embedding: Float32Array;
    }> = [];
    for (const row of rows) {
      const embedding = decodeEmbedding(row.imageEmbedding);
      if (!embedding) {
        // Undecodable (corrupt/zero) — stamp it processed-with-no-cluster so
        // the backfill doesn't retry it forever, same treatment as faces'
        // UNCLUSTERABLE_CLUSTER_ID.
        await this.db.run(
          `UPDATE files SET momentClusterProcessedAt = ? WHERE folder = ? AND fileName = ?`,
          Date.now(),
          row.folder,
          row.fileName,
        );
        continue;
      }
      out.push({
        folder: row.folder,
        fileName: row.fileName,
        dateTaken: row.dateTaken,
        embedding,
      });
    }
    return out;
  }

  /**
   * Reconstructs the clustering chain state as of just before the sweep's
   * next batch starts (`adjacentDateTaken` is that batch's first item's
   * dateTaken) — the nearest already-*processed* file on the side the sweep
   * is coming *from*, and, if it belongs to a cluster, that cluster's
   * persisted running centroid. Lets the task resume correctly after a
   * restart or across batch boundaries without re-scanning already-processed
   * files.
   *
   * Direction-aware (2026-08-12): the sweep now consumes the backlog
   * newest-first (see getMomentClusteringBatch), so "just before" in
   * *processing order* means "immediately newer in *capture time*" — this
   * looks for the nearest processed file with dateTaken >= the threshold,
   * not <=. Renamed from getPrecedingMomentClusterState (which searched
   * dateTaken <= threshold, correct for the old oldest-first sweep) to avoid
   * a misleading name now that "preceding" means something different.
   */
  async getMomentClusteringSweepSeedState(adjacentDateTaken: number): Promise<{
    clusterId: number | null;
    centroidSum: Float32Array;
    weight: number;
    dateTaken: number;
    /** Only meaningful when clusterId is null — the standalone predecessor's
     * own path, so it can be retroactively promoted if the next file joins it. */
    folder: string;
    fileName: string;
  } | null> {
    const row = await this.db.get<{
      folder: string;
      fileName: string;
      dateTaken: number;
      momentClusterId: number | null;
      imageEmbedding: Buffer | null;
    }>(
      `SELECT files.folder, files.fileName, files.dateTaken, files.momentClusterId,
              fileEmbeddings.imageEmbedding
       FROM files
       LEFT JOIN fileEmbeddings
         ON fileEmbeddings.folder = files.folder AND fileEmbeddings.fileName = files.fileName
       WHERE files.momentClusterProcessedAt IS NOT NULL
         AND files.dateTaken IS NOT NULL
         AND files.dateTaken >= ?
       ORDER BY files.dateTaken ASC, files.folder ASC, files.fileName ASC
       LIMIT 1`,
      adjacentDateTaken,
    );
    if (!row) return null;

    if (row.momentClusterId) {
      const cluster = await this.db.get<{ centroid: Buffer | null; weight: number }>(
        `SELECT centroid, weight FROM momentClusters WHERE id = ?`,
        row.momentClusterId,
      );
      if (cluster?.centroid && cluster.weight > 0) {
        const decoded = decodeEmbedding(cluster.centroid);
        if (decoded) {
          // decodeEmbedding re-normalizes to unit length; scale back up so the
          // running-sum math in momentClusterEngine (which divides by weight)
          // reconstructs the same average.
          const centroidSum = new Float32Array(decoded.length);
          for (let i = 0; i < decoded.length; i += 1) {
            centroidSum[i] = decoded[i] * cluster.weight;
          }
          return {
            clusterId: row.momentClusterId,
            centroidSum,
            weight: cluster.weight,
            dateTaken: row.dateTaken,
            folder: row.folder,
            fileName: row.fileName,
          };
        }
      }
    }

    // Standalone predecessor (no cluster, or its embedding/centroid couldn't be
    // read) — seed a fresh single-file candidate chain from its own embedding.
    const embedding = decodeEmbedding(row.imageEmbedding);
    if (!embedding) return null;
    return {
      clusterId: null,
      centroidSum: embedding,
      weight: 1,
      dateTaken: row.dateTaken,
      folder: row.folder,
      fileName: row.fileName,
    };
  }

  /** Creates a new moment cluster row and returns its id. */
  async createMomentCluster(): Promise<number> {
    const now = Date.now();
    const result = await this.db.run(
      `INSERT INTO momentClusters (weight, createdAt, updatedAt, representativePinned) VALUES (0, ?, ?, 0)`,
      now,
      now,
    );
    return Number(result.lastInsertRowid);
  }

  /**
   * Retroactively assigns a already-processed, already-written file to a
   * moment cluster — used when that file was the sole member of an open chain
   * (momentClusterId left NULL) and a later file joins it, confirming the
   * chain is a real cluster after the fact. Leaves sharpnessScore and
   * momentClusterProcessedAt untouched; only the cluster assignment changes.
   */
  async promoteFileToMomentCluster(
    folder: string,
    fileName: string,
    clusterId: number,
  ): Promise<void> {
    await this.db.run(
      `UPDATE files SET momentClusterId = ? WHERE folder = ? AND fileName = ?`,
      clusterId,
      folder,
      fileName,
    );
  }

  /** Persists a moment cluster's running centroid (used as new members join). */
  async saveMomentClusterCentroid(
    clusterId: number,
    centroidSum: Float32Array,
    weight: number,
  ): Promise<void> {
    // Store the *normalized average*, not the raw sum: encodeEmbedding
    // unit-normalizes whatever it's given, and getMomentClusteringSweepSeedState
    // rescales it back up by `weight` on read, so storing the average (rather
    // than a sum that keeps growing in magnitude) keeps the encode step's
    // int8 quantization grid well-used regardless of cluster size.
    const average = new Float32Array(centroidSum.length);
    for (let i = 0; i < centroidSum.length; i += 1) average[i] = centroidSum[i] / weight;
    const encoded = encodeEmbedding(average);
    await this.db.run(
      `UPDATE momentClusters SET centroid = ?, weight = ?, updatedAt = ? WHERE id = ?`,
      encoded,
      weight,
      Date.now(),
      clusterId,
    );
  }

  /**
   * Writes one batch's worth of clustering decisions: each file's assigned
   * momentClusterId (or null for "stands alone"), its computed sharpness
   * score, and the processed-marker timestamp.
   */
  async saveMomentClusteringBatch(
    updates: Array<{
      folder: string;
      fileName: string;
      momentClusterId: number | null;
      sharpnessScore: number | null;
    }>,
  ): Promise<void> {
    const now = Date.now();
    await this.db.transaction(
      updates.map((update) => ({
        sql: `UPDATE files SET momentClusterId = ?, sharpnessScore = ?, momentClusterProcessedAt = ?
              WHERE folder = ? AND fileName = ?`,
        params: [
          update.momentClusterId,
          update.sharpnessScore,
          now,
          update.folder,
          update.fileName,
        ],
      })),
    );
  }

  /**
   * Re-ranks a cluster's members (see momentClusterEngine.pickRepresentative)
   * and writes the winner's momentClusterRepresentative flag. No-op if the
   * cluster's representative was manually pinned by a user (see
   * setMomentClusterRepresentative).
   */
  async recomputeMomentClusterRepresentative(clusterId: number): Promise<void> {
    const cluster = await this.db.get<{ representativePinned: number }>(
      `SELECT representativePinned FROM momentClusters WHERE id = ?`,
      clusterId,
    );
    if (!cluster || cluster.representativePinned) return;

    const members = await this.db.all<{
      folder: string;
      fileName: string;
      sharpnessScore: number | null;
      photoQualityScore: number | null;
    }>(
      `SELECT folder, fileName, sharpnessScore, photoQualityScore FROM files WHERE momentClusterId = ?`,
      clusterId,
    );
    const winner = pickRepresentative(members);
    if (!winner) return;

    await this.db.transaction([
      {
        sql: `UPDATE files SET momentClusterRepresentative = 0 WHERE momentClusterId = ?`,
        params: [clusterId],
      },
      {
        sql: `UPDATE files SET momentClusterRepresentative = 1 WHERE folder = ? AND fileName = ?`,
        params: [winner.folder, winner.fileName],
      },
    ]);
  }

  /** Progress counters for the moment-clustering task's status display. */
  async getMomentClusteringProgress(): Promise<{ processed: number; pending: number }> {
    const [processedRow, pendingRow] = await Promise.all([
      this.db.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM files WHERE mimeType LIKE 'image/%' AND momentClusterProcessedAt IS NOT NULL`,
      ),
      this.db.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM files WHERE mimeType LIKE 'image/%' AND momentClusterProcessedAt IS NULL AND dateTaken IS NOT NULL`,
      ),
    ]);
    return { processed: processedRow?.count ?? 0, pending: pendingRow?.count ?? 0 };
  }

  /**
   * Full member listing for one moment cluster — powers the gallery's "expand
   * this stack" interaction. Ordered representative-first, then by descending
   * quality score so the next-best pick is easy to find.
   */
  async getMomentClusterDetail(clusterId: string): Promise<MomentClusterDetail | null> {
    const numericId = Number.parseInt(clusterId, 10);
    if (!Number.isFinite(numericId)) return null;

    const rows = await this.db.all<{
      folder: string;
      fileName: string;
      mimeType: string | null;
      dimensionsWidth: number | null;
      dimensionsHeight: number | null;
      momentClusterRepresentative: number;
      sharpnessScore: number | null;
      photoQualityScore: number | null;
    }>(
      `SELECT folder, fileName, mimeType, dimensionsWidth, dimensionsHeight,
              momentClusterRepresentative, sharpnessScore, photoQualityScore
       FROM files
       WHERE momentClusterId = ?
       ORDER BY momentClusterRepresentative DESC, photoQualityScore DESC, sharpnessScore DESC`,
      numericId,
    );
    if (rows.length === 0) return null;

    return {
      id: clusterId,
      members: rows.map((row) => ({
        path: row.folder + row.fileName,
        fileName: row.fileName,
        mimeType: row.mimeType,
        dimensionWidth: row.dimensionsWidth,
        dimensionHeight: row.dimensionsHeight,
        isRepresentative: Number(row.momentClusterRepresentative) === 1,
        sharpnessScore: row.sharpnessScore,
        photoQualityScore: row.photoQualityScore,
      })),
    };
  }

  /**
   * User override: makes `relativePath` the cluster's representative and pins
   * it, so the automatic sharpness/quality re-scoring in
   * recomputeMomentClusterRepresentative never overwrites the choice again.
   * Returns false if the cluster or the file (as a member of it) doesn't exist.
   */
  async setMomentClusterRepresentative(
    clusterId: string,
    relativePath: string,
  ): Promise<boolean> {
    const numericId = Number.parseInt(clusterId, 10);
    if (!Number.isFinite(numericId)) return false;
    const { folder, fileName } = splitPath(relativePath);

    const member = await this.db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM files WHERE momentClusterId = ? AND folder = ? AND fileName = ?`,
      numericId,
      folder,
      fileName,
    );
    if (!member || member.count === 0) return false;

    await this.db.transaction([
      {
        sql: `UPDATE files SET momentClusterRepresentative = 0 WHERE momentClusterId = ?`,
        params: [numericId],
      },
      {
        sql: `UPDATE files SET momentClusterRepresentative = 1 WHERE folder = ? AND fileName = ?`,
        params: [folder, fileName],
      },
      {
        sql: `UPDATE momentClusters SET representativePinned = 1, updatedAt = ? WHERE id = ?`,
        params: [Date.now(), numericId],
      },
    ]);
    return true;
  }

  /**
   * Permanently dissolves a moment cluster: every member's momentClusterId and
   * momentClusterRepresentative are cleared (so they behave like ordinary,
   * never-clustered photos and each show individually in the gallery from now
   * on) and the cluster row itself is deleted. This is the "unstack
   * permanently" action; the temporary/session-only version never reaches the
   * database at all — it's purely client-side state.
   *
   * Members are left with momentClusterProcessedAt already set, so the
   * background task never re-evaluates or re-clusters them.
   */
  async dissolveMomentCluster(clusterId: string): Promise<boolean> {
    const numericId = Number.parseInt(clusterId, 10);
    if (!Number.isFinite(numericId)) return false;

    const existing = await this.db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM files WHERE momentClusterId = ?`,
      numericId,
    );
    if (!existing || existing.count === 0) return false;

    await this.db.transaction([
      {
        sql: `UPDATE files SET momentClusterId = NULL, momentClusterRepresentative = 0 WHERE momentClusterId = ?`,
        params: [numericId],
      },
      { sql: `DELETE FROM momentClusters WHERE id = ?`, params: [numericId] },
    ]);
    return true;
  }

  /**
   * Cleans up "cluster" rows that ended up with only one member and dissolves
   * them (same effect as dissolveMomentCluster, just automatic). A cluster is
   * only ever *created* when a second photo joins one — see
   * processMomentClustering.ts — but the result can still end up a singleton:
   *
   *  - A process restart mid-batch can leave a cluster's first member eagerly
   *    promoted (a direct, unbatched write via promoteFileToMomentCluster)
   *    while the second member's own join never got committed (it was queued
   *    in the same batch's still-in-flight transaction).
   *  - Confirmed live on 2026-08-12: this also happens during perfectly
   *    ordinary, uninterrupted operation — not just restarts (root cause not
   *    yet isolated; suspected to involve the in-batch chain-reassignment
   *    path when a cluster is created and then broken again within the same
   *    batch). This was found via a direct DB inspection showing thousands of
   *    singleton clusters with `momentClusterProcessedAt` timestamps from
   *    hours of continuous runtime, no restart in between.
   *
   * Either way the result is harmless to what users see — a stack badge only
   * ever shows for count > 1, and the collapsed gallery query still returns
   * the lone "member" as an ordinary photo — but it's DB clutter, and the
   * member's momentClusterProcessedAt marker is already set so the background
   * task will never revisit it on its own. Called periodically (every
   * PRUNE_SINGLETONS_EVERY_N_BATCHES batches, not just once at full backlog
   * drain — see processMomentClustering.ts's comment for why "once at drain"
   * turned out to be effectively dead code on a library this size).
   */
  async pruneSingletonMomentClusters(): Promise<number> {
    const orphans = await this.db.all<{ momentClusterId: number }>(
      `SELECT momentClusterId FROM files
       WHERE momentClusterId IS NOT NULL
       GROUP BY momentClusterId
       HAVING COUNT(*) = 1`,
    );
    if (orphans.length === 0) return 0;

    await this.db.transaction(
      orphans.flatMap(({ momentClusterId }) => [
        {
          sql: `UPDATE files SET momentClusterId = NULL, momentClusterRepresentative = 0 WHERE momentClusterId = ?`,
          params: [momentClusterId],
        },
        { sql: `DELETE FROM momentClusters WHERE id = ?`, params: [momentClusterId] },
      ]),
    );
    return orphans.length;
  }

}
