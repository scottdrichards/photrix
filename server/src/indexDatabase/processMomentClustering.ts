import path from "node:path";
import { getLogger } from "../observability/logger.ts";
import { stripLeadingSlash } from "../common/stripLeadingSlash.ts";
import { computeSharpnessScore } from "../imageProcessing/sharpness.ts";
import type { IndexDatabase } from "./indexDatabase.ts";
import type { TaskRunner } from "../taskOrchestrator/taskOrchestrator.ts";
import { createTaskController } from "../taskOrchestrator/taskController.ts";
import {
  MOMENT_WINDOW_MS,
  MOMENT_VISUAL_SIMILARITY_THRESHOLD,
  centroidSimilarity,
  foldIntoCentroid,
} from "./momentClusterEngine.ts";

const log = getLogger("processMomentClustering");

// Chunk boundary for pause/cancel and for the transactional write at the end
// of each pass. Smaller than face clustering's 64 because each file here also
// pays for a sharpness decode (a small `sharp` resize + a pixel-loop), not just
// an in-memory dot product.
const BATCH_SIZE = 32;

// How often (in batches) to sweep for orphaned singleton clusters — see
// pruneSingletonMomentClusters's doc comment for how they arise. Originally
// this only ran once, after the *entire* backlog drained; on a library this
// size (~192k photos) that point is effectively unreachable within any single
// run, which made the cleanup dead code in practice — verified live on
// 2026-08-12: thousands of orphans had already accumulated from ordinary
// steady-state operation, not just restarts. Running it every 200 batches
// (~6,400 files) bounds the clutter without adding meaningful overhead — the
// underlying query is an index-only GROUP BY over `by_moment_cluster`.
const PRUNE_SINGLETONS_EVERY_N_BATCHES = 200;

/**
 * The currently-open chain of temporally/visually adjacent photos. `clusterId`
 * is null while the chain is still an unconfirmed single-file candidate — a
 * `momentClusters` row only gets created (and this promoted to non-null) the
 * moment a second photo actually joins it. `folder`/`fileName` always track
 * the *most recently added* member — "first"/"most recent" here means
 * *sweep order*, not calendar order: with the sweep now running
 * newest-first, the chain's first member is its chronologically *newest*
 * photo — so a confirmed-real cluster can still be retroactively backfilled
 * onto its first (already-written, sweep-order) member.
 */
type ChainState = {
  clusterId: number | null;
  centroidSum: Float32Array;
  weight: number;
  lastDateTaken: number;
  lastFolder: string;
  lastFileName: string;
};

/**
 * Backfills moment-cluster assignments (burst shots / near-duplicate frames)
 * onto images that don't have one yet: a single pass over files in
 * capture-time order — **newest-first** as of 2026-08-12 (see
 * IndexDatabase.getMomentClusteringBatch's doc comment for why) — chaining
 * each photo onto the currently-open cluster when it is both close in time
 * (MOMENT_WINDOW_MS) and visually similar (MOMENT_VISUAL_SIMILARITY_THRESHOLD,
 * over the CLIP embedding already stored by image analysis — no new embedding
 * computed here) to that cluster's running centroid, otherwise starting a new
 * candidate chain.
 *
 * Runs on the background queue like every other processor: it claims work in
 * capture-time-ordered batches, so it is resumable (see
 * getMomentClusteringSweepSeedState, which reconstructs the in-flight chain
 * state from what was already persisted, on whichever side of the batch the
 * sweep is coming from) and yields to user requests between batches.
 */
export const processMomentClustering = (database: IndexDatabase): TaskRunner => {
  const ctrl = createTaskController("Moment clustering cancelled");

  const completion: Promise<void> = (async () => {
    let chain: ChainState | null = null;
    let totalProcessed = 0;
    let totalPruned = 0;
    let batchesSinceLastPrune = 0;

    while (true) {
      ctrl.checkCancelled();
      await ctrl.waitUntilResumed();
      ctrl.checkCancelled();

      const files = await database.getMomentClusteringBatch(BATCH_SIZE);
      if (files.length === 0) break;

      if (!chain) {
        const seed = await database.getMomentClusteringSweepSeedState(files[0].dateTaken);
        chain = seed
          ? {
              clusterId: seed.clusterId,
              centroidSum: seed.centroidSum,
              weight: seed.weight,
              lastDateTaken: seed.dateTaken,
              lastFolder: seed.folder,
              lastFileName: seed.fileName,
            }
          : null;
      }

      const updates: Array<{
        folder: string;
        fileName: string;
        momentClusterId: number | null;
        sharpnessScore: number | null;
      }> = [];
      const touchedClusterIds = new Set<number>();

      for (const file of files) {
        const fullPath = path.join(
          database.storagePath,
          stripLeadingSlash(file.folder + file.fileName),
        );
        const sharpnessScore = await computeSharpnessScore(fullPath);

        // Math.abs, not a bare subtraction: the sweep direction determines
        // whether `file` is older or newer than the chain's last member (as
        // of 2026-08-12 the sweep runs newest-first, so `file.dateTaken` is
        // now *smaller* than `chain.lastDateTaken` on every join — a bare
        // `file.dateTaken - chain.lastDateTaken` would be negative and
        // trivially satisfy `<= MOMENT_WINDOW_MS` for photos arbitrarily far
        // apart, defeating the whole point of the window gate). Written this
        // way it's correct regardless of which direction the sweep runs.
        const withinWindow =
          !!chain && Math.abs(file.dateTaken - chain.lastDateTaken) <= MOMENT_WINDOW_MS;
        const similarity =
          chain && withinWindow
            ? centroidSimilarity(chain.centroidSum, chain.weight, file.embedding)
            : -1;

        let assignedClusterId: number | null = null;

        if (chain && withinWindow && similarity >= MOMENT_VISUAL_SIMILARITY_THRESHOLD) {
          // Joins the open chain.
          if (chain.clusterId === null) {
            // Second member confirms this is a real cluster — create it and
            // retroactively assign the chain's first member (already written,
            // possibly in an earlier batch or a prior run) to it too.
            const clusterId = await database.createMomentCluster();
            await database.promoteFileToMomentCluster(
              chain.lastFolder,
              chain.lastFileName,
              clusterId,
            );
            chain.clusterId = clusterId;
            touchedClusterIds.add(clusterId);
          }
          assignedClusterId = chain.clusterId;
          chain.centroidSum = foldIntoCentroid(chain.centroidSum, file.embedding);
          chain.weight += 1;
          touchedClusterIds.add(assignedClusterId);
        } else {
          // Chain breaks (or never started): this file becomes the new
          // single-candidate chain.
          chain = {
            clusterId: null,
            centroidSum: file.embedding,
            weight: 1,
            lastDateTaken: file.dateTaken,
            lastFolder: file.folder,
            lastFileName: file.fileName,
          };
        }

        chain.lastDateTaken = file.dateTaken;
        chain.lastFolder = file.folder;
        chain.lastFileName = file.fileName;

        updates.push({
          folder: file.folder,
          fileName: file.fileName,
          momentClusterId: assignedClusterId,
          sharpnessScore,
        });
      }

      await database.saveMomentClusteringBatch(updates);

      // Persist the open chain's centroid so a restart (or the next batch,
      // which re-derives its seed from the DB) picks up exactly where this
      // left off.
      if (chain?.clusterId !== null && chain) {
        await database.saveMomentClusterCentroid(chain.clusterId, chain.centroidSum, chain.weight);
      }
      for (const clusterId of touchedClusterIds) {
        await database.recomputeMomentClusterRepresentative(clusterId);
      }

      totalProcessed += files.length;
      batchesSinceLastPrune += 1;

      // See pruneSingletonMomentClusters's doc comment and
      // PRUNE_SINGLETONS_EVERY_N_BATCHES above: orphaned singleton clusters
      // form during ordinary operation, not just at a restart, so cleanup
      // can't wait for a full-backlog drain that may never happen in one run.
      if (batchesSinceLastPrune >= PRUNE_SINGLETONS_EVERY_N_BATCHES) {
        batchesSinceLastPrune = 0;
        totalPruned += await database.pruneSingletonMomentClusters();
      }
    }

    // Final sweep in case the backlog drained between periodic prunes.
    totalPruned += await database.pruneSingletonMomentClusters();

    if (totalProcessed > 0 || totalPruned > 0) {
      log.info({ totalProcessed, totalPruned }, "Moment clustering backlog drained");
    }
    ctrl.markComplete();
  })();

  return {
    pause: ctrl.pause,
    resume: ctrl.resume,
    cancel: ctrl.cancel,
    getStatus: async () => {
      const { processed, pending } = await database.getMomentClusteringProgress();
      const total = processed + pending;
      return {
        state: ctrl.state,
        itemsProcessed: processed,
        total,
        portionComplete: total > 0 ? processed / total : undefined,
      };
    },
    onComplete: () => completion,
  };
};
