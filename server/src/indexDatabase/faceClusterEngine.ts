import type { AsyncSqlite } from "../common/asyncSqlite.ts";
import { runWithoutRequestAbortSignal } from "../common/requestAbort.ts";
import { getLogger } from "../observability/logger.ts";

const log = getLogger("faceClusterEngine");

/**
 * Two face embeddings closer than this cosine similarity are considered the
 * same person. Changing it invalidates every persisted assignment: the engine
 * detects the mismatch on load, clears `faces.clusterId`, and the background
 * clustering task re-derives everything at the new threshold.
 */
export const FACE_CLUSTER_SIMILARITY_THRESHOLD = 0.62;

/**
 * Sentinel clusterId for faces whose embedding can't be normalized (corrupt or
 * zero-magnitude BLOB). Marking them keeps the backfill's "clusterId IS NULL"
 * query from returning the same undecodable faces forever; People queries
 * exclude them with `clusterId > 0`.
 */
export const UNCLUSTERABLE_CLUSTER_ID = 0;

/**
 * Incremental greedy face clustering with persisted state.
 *
 * Each cluster keeps a running (unnormalized) mean of its member faces' unit
 * embedding vectors. A new face joins the first cluster whose centroid clears
 * the similarity threshold, otherwise it starts a new cluster. Assignments are
 * written to `faces.clusterId`/`faces.clusterSimilarity` and centroids to the
 * `faceClusters` table, so the People tab reads plain indexed columns instead
 * of re-clustering per request.
 *
 * Approximations, by design:
 * - Greedy order-dependence: same trade the previous per-request clustering
 *   made, but now each face is clustered exactly once.
 * - Bulk deletions (files removed from disk) do not subtract their vectors
 *   from centroids; the ghost weight only nudges future assignments, never the
 *   displayed data (counts/faces always come from live `faces` rows). Per-file
 *   re-detection does subtract, so the steady state stays accurate, and
 *   `pruneEmptyClusters` drops clusters with no remaining members.
 *
 * All math is Float32: the face model emits 32-bit precision, so the Float64
 * storage of `faces.embedding` carries no extra information, and Float32 halves
 * the memory traffic in the hot dot-product loop.
 */
export class FaceClusterEngine {
  private db: AsyncSqlite;
  /** Sorted by weight descending (approximately — see resortIfDue). */
  private clusters: Array<{
    id: number;
    /** Unnormalized running mean of member unit vectors. */
    mean: Float32Array;
    /** Cached |mean|, so similarity is dot(v, mean) / magnitude. */
    magnitude: number;
    weight: number;
  }> = [];
  private clustersById = new Map<number, FaceClusterEngine["clusters"][number]>();
  private nextClusterId = 1;
  private loadPromise?: Promise<void>;
  private mutationsSinceSort = 0;
  /** Serializes all mutations: in-memory state and DB writes must not interleave. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(db: AsyncSqlite) {
    this.db = db;
  }

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    // The chain's results are shared state, not per-request responses; never
    // let a requester's disconnect abort a chained operation midway.
    const run = () => runWithoutRequestAbortSignal(fn);
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    return result;
  }

  private ensureLoaded(): Promise<void> {
    // Memoized across requests: the first caller's abort signal must not leak
    // into the load and cache a rejected promise for everyone after it.
    this.loadPromise ??= runWithoutRequestAbortSignal(() => this.load());
    return this.loadPromise;
  }

  private async load(): Promise<void> {
    const rows = await this.db.all<{
      id: number;
      centroid: Buffer;
      weight: number;
      threshold: number;
    }>("SELECT id, centroid, weight, threshold FROM faceClusters");

    const staleThreshold = rows.some(
      (row) => row.threshold !== FACE_CLUSTER_SIMILARITY_THRESHOLD,
    );
    if (staleThreshold) {
      log.warn(
        { threshold: FACE_CLUSTER_SIMILARITY_THRESHOLD },
        "Face cluster threshold changed — resetting persisted assignments for re-clustering",
      );
      await this.db.transaction([
        { sql: "DELETE FROM faceClusters", params: [] },
        {
          sql: "UPDATE faces SET clusterId = NULL, clusterSimilarity = NULL WHERE clusterId IS NOT NULL",
          params: [],
        },
      ]);
      return;
    }

    for (const row of rows) {
      const mean = toAlignedFloat32(row.centroid);
      const cluster = {
        id: row.id,
        mean,
        magnitude: magnitudeOf(mean),
        weight: row.weight,
      };
      this.clusters.push(cluster);
      this.clustersById.set(row.id, cluster);
      this.nextClusterId = Math.max(this.nextClusterId, row.id + 1);
    }
    this.clusters.sort((a, b) => b.weight - a.weight);
    log.info({ clusters: this.clusters.length }, "Face cluster centroids loaded");
  }

  /**
   * Assigns each face to a cluster and persists the results. Faces whose
   * embedding is empty or zero are skipped (they stay clusterId NULL but are
   * excluded from the backfill query by its LENGTH(embedding) > 0 filter).
   */
  assignFaces(
    faces: Array<{ id: number; embedding: Buffer | Uint8Array }>,
  ): Promise<void> {
    if (!faces.length) return Promise.resolve();
    return this.runExclusive(async () => {
      await this.ensureLoaded();

      const now = Date.now();
      const faceUpdates: Array<{ sql: string; params: unknown[] }> = [];
      const dirty = new Set<FaceClusterEngine["clusters"][number]>();

      let processed = 0;
      for (const face of faces) {
        // Scanning tens of thousands of centroids per face can take tens of
        // milliseconds; yield so a big batch doesn't monopolize the event loop.
        if ((processed++ & 0x7) === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }

        const unit = toUnitFloat32(face.embedding);
        if (!unit) {
          faceUpdates.push({
            sql: "UPDATE faces SET clusterId = ?, clusterSimilarity = NULL WHERE id = ?",
            params: [UNCLUSTERABLE_CLUSTER_ID, face.id],
          });
          continue;
        }

        this.resortIfDue();
        let match: FaceClusterEngine["clusters"][number] | undefined;
        let similarity = -1;
        for (const cluster of this.clusters) {
          const dot = dotProduct(unit, cluster.mean) / cluster.magnitude;
          // First-match-above-threshold, scanning big clusters first: distinct
          // people essentially never both clear the (high) threshold for the
          // same face, so the first hit is the right one and the scan usually
          // ends within the few large clusters.
          if (dot >= FACE_CLUSTER_SIMILARITY_THRESHOLD) {
            match = cluster;
            similarity = dot;
            break;
          }
        }

        if (match) {
          const { mean, weight } = match;
          for (let i = 0; i < mean.length; i += 1) {
            mean[i] = (mean[i] * weight + unit[i]) / (weight + 1);
          }
          match.weight = weight + 1;
          match.magnitude = magnitudeOf(mean);
        } else {
          match = {
            id: this.nextClusterId++,
            mean: unit,
            magnitude: 1,
            weight: 1,
          };
          similarity = 1;
          this.clusters.push(match);
          this.clustersById.set(match.id, match);
        }
        dirty.add(match);
        this.mutationsSinceSort += 1;

        faceUpdates.push({
          sql: "UPDATE faces SET clusterId = ?, clusterSimilarity = ? WHERE id = ?",
          params: [match.id, similarity, face.id],
        });
      }

      await this.persist(faceUpdates, dirty, now);
    });
  }

  /**
   * Subtracts faces from their clusters' running means — used when a file's
   * faces are deleted ahead of re-detection, so re-detected faces don't count
   * twice. Clusters whose weight reaches zero are removed.
   */
  removeFaces(
    faces: Array<{ clusterId: number; embedding: Buffer | Uint8Array }>,
  ): Promise<void> {
    if (!faces.length) return Promise.resolve();
    return this.runExclusive(async () => {
      await this.ensureLoaded();

      const now = Date.now();
      const statements: Array<{ sql: string; params: unknown[] }> = [];
      const dirty = new Set<FaceClusterEngine["clusters"][number]>();

      for (const face of faces) {
        const cluster = this.clustersById.get(face.clusterId);
        if (!cluster) continue;
        const unit = toUnitFloat32(face.embedding);
        if (!unit) continue;

        if (cluster.weight <= 1) {
          this.clustersById.delete(cluster.id);
          this.clusters.splice(this.clusters.indexOf(cluster), 1);
          dirty.delete(cluster);
          statements.push({
            sql: "DELETE FROM faceClusters WHERE id = ?",
            params: [cluster.id],
          });
          continue;
        }

        const { mean, weight } = cluster;
        for (let i = 0; i < mean.length; i += 1) {
          mean[i] = (mean[i] * weight - unit[i]) / (weight - 1);
        }
        cluster.weight = weight - 1;
        cluster.magnitude = magnitudeOf(mean);
        dirty.add(cluster);
        this.mutationsSinceSort += 1;
      }

      await this.persist(statements, dirty, now);
    });
  }

  /**
   * Drops clusters that no longer have any member faces (e.g. after bulk file
   * removals). Run when the backfill drains; keeps the scan set from
   * accumulating ghosts.
   */
  pruneEmptyClusters(): Promise<void> {
    return this.runExclusive(async () => {
      await this.ensureLoaded();
      const liveRows = await this.db.all<{ clusterId: number }>(
        "SELECT DISTINCT clusterId FROM faces WHERE clusterId IS NOT NULL",
      );
      const live = new Set(liveRows.map((row) => row.clusterId));
      const empty = this.clusters.filter((cluster) => !live.has(cluster.id));
      if (!empty.length) return;

      for (const cluster of empty) {
        this.clustersById.delete(cluster.id);
      }
      this.clusters = this.clusters.filter((cluster) => live.has(cluster.id));
      await this.db.transaction(
        empty.map((cluster) => ({
          sql: "DELETE FROM faceClusters WHERE id = ?",
          params: [cluster.id],
        })),
      );
      log.info({ pruned: empty.length }, "Pruned empty face clusters");
    });
  }

  private async persist(
    statements: Array<{ sql: string; params: unknown[] }>,
    dirty: Set<FaceClusterEngine["clusters"][number]>,
    updatedAt: number,
  ): Promise<void> {
    for (const cluster of dirty) {
      statements.push({
        sql: `INSERT INTO faceClusters (id, centroid, weight, threshold, updatedAt)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                centroid = excluded.centroid,
                weight = excluded.weight,
                updatedAt = excluded.updatedAt`,
        params: [
          cluster.id,
          Buffer.from(cluster.mean.buffer.slice(0)),
          cluster.weight,
          FACE_CLUSTER_SIMILARITY_THRESHOLD,
          updatedAt,
        ],
      });
    }
    if (statements.length) {
      await this.db.transaction(statements);
    }
  }

  /**
   * Merges sourceId cluster into targetId: combines the running means and
   * reassigns all source faces to target in the DB. The source cluster is
   * deleted. Caller must separately UPDATE faces SET clusterId = targetId.
   */
  mergeCluster(sourceId: number, targetId: number): Promise<void> {
    return this.runExclusive(async () => {
      await this.ensureLoaded();
      const source = this.clustersById.get(sourceId);
      const target = this.clustersById.get(targetId);
      if (!source || !target) return;

      // Combine running means: weighted average of both unnormalized sums.
      const totalWeight = source.weight + target.weight;
      for (let i = 0; i < target.mean.length; i += 1) {
        target.mean[i] =
          (target.mean[i] * target.weight + source.mean[i] * source.weight) / totalWeight;
      }
      target.weight = totalWeight;
      target.magnitude = magnitudeOf(target.mean);

      this.clustersById.delete(sourceId);
      this.clusters.splice(this.clusters.indexOf(source), 1);
      this.mutationsSinceSort += 1;

      await this.db.transaction([
        {
          sql: "UPDATE faces SET clusterId = ?, clusterSimilarity = NULL WHERE clusterId = ?",
          params: [targetId, sourceId],
        },
        { sql: "DELETE FROM faceClusters WHERE id = ?", params: [sourceId] },
        {
          sql: `INSERT INTO faceClusters (id, centroid, weight, threshold, updatedAt)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  centroid = excluded.centroid,
                  weight = excluded.weight,
                  updatedAt = excluded.updatedAt`,
          params: [
            targetId,
            Buffer.from(target.mean.buffer.slice(0)),
            target.weight,
            FACE_CLUSTER_SIMILARITY_THRESHOLD,
            Date.now(),
          ],
        },
      ]);
    });
  }

  /**
   * Keeps the scan order roughly weight-descending so the early-exit match
   * scan hits large clusters first. Exact order doesn't matter, so re-sorting
   * every so often is enough.
   */
  private resortIfDue(): void {
    if (this.mutationsSinceSort < 1024) return;
    this.clusters.sort((a, b) => b.weight - a.weight);
    this.mutationsSinceSort = 0;
  }
}

/** Copies a possibly-unaligned BLOB into an aligned Float32Array view. */
export const toAlignedFloat32 = (buffer: Buffer | Uint8Array): Float32Array => {
  const aligned = new Uint8Array(buffer.byteLength);
  aligned.set(buffer);
  return new Float32Array(aligned.buffer);
};

/**
 * Converts a stored Float64 embedding BLOB into a Float32 unit vector.
 * Returns null for empty or zero-magnitude embeddings.
 */
export const toUnitFloat32 = (buffer: Buffer | Uint8Array): Float32Array | null => {
  if (buffer.byteLength === 0 || buffer.byteLength % 8 !== 0) return null;
  const aligned = new Uint8Array(buffer.byteLength);
  aligned.set(buffer);
  const f64 = new Float64Array(aligned.buffer);

  let magnitudeSquared = 0;
  for (let i = 0; i < f64.length; i += 1) {
    magnitudeSquared += f64[i] * f64[i];
  }
  if (magnitudeSquared <= 0) return null;

  const magnitude = Math.sqrt(magnitudeSquared);
  const unit = new Float32Array(f64.length);
  for (let i = 0; i < f64.length; i += 1) {
    unit[i] = f64[i] / magnitude;
  }
  return unit;
};

/** 4-way unrolled dot product — ~1.5× the plain loop on 512-dim vectors. */
export const dotProduct = (a: Float32Array, b: Float32Array): number => {
  const length = Math.min(a.length, b.length);
  const limit = length - (length % 4);
  let d0 = 0;
  let d1 = 0;
  let d2 = 0;
  let d3 = 0;
  for (let i = 0; i < limit; i += 4) {
    d0 += a[i] * b[i];
    d1 += a[i + 1] * b[i + 1];
    d2 += a[i + 2] * b[i + 2];
    d3 += a[i + 3] * b[i + 3];
  }
  let rest = 0;
  for (let i = limit; i < length; i += 1) {
    rest += a[i] * b[i];
  }
  return d0 + d1 + d2 + d3 + rest;
};

const magnitudeOf = (vector: Float32Array): number => {
  let magnitudeSquared = 0;
  for (let i = 0; i < vector.length; i += 1) {
    magnitudeSquared += vector[i] * vector[i];
  }
  return Math.sqrt(magnitudeSquared);
};
