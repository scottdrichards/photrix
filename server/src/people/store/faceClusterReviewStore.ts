import type { FaceClusterLayout } from "./faceClusterLayout.ts";
import { AsyncSqlite } from "../../common/asyncSqlite.ts";
import { type FaceReviewFace, type FaceReviewResult } from "../../indexDatabase/indexDatabase.type.ts";
import { FaceClusterEngine, type FaceVerdict, toUnitFloat32 } from "./faceClusterEngine.ts";
import { dotProduct } from "../../common/dotProduct.ts";
import { toAlignedFloat32 } from "../../common/toAlignedFloat32.ts";
import { planOptimization, scoreAnomalies, suggestCutoff, type AnomalyInput, type OptimizeCluster, type OptimizeProposal } from "../review/faceReview.ts";
import { faceClusterIdToString, faceClusterIdFromString } from "./faceClusterId.ts";
import { faceRowToClusterFace } from "./faceRowToClusterFace.ts";

/** Getting the wrong faces out of a person: the review list, verdicts, the cut line and the optimiser's plan. */
export class FaceClusterReviewStore {
  constructor(
    private readonly db: AsyncSqlite,
    private readonly faceClusters: FaceClusterEngine,
    private readonly layout: FaceClusterLayout,
  ) {}

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
  async resolvePersonClusters(
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
    this.layout.invalidateFaceClusterPCACache();
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
      this.layout.invalidateFaceClusterPCACache();
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
      this.layout.invalidateFaceClusterPCACache();
      return withEmbedding.length;
    }

    this.layout.invalidateFaceClusterPCACache();
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
    this.layout.invalidateFaceClusterPCACache();
  }

  /**
   * Re-asserts stored verdicts after the clustering backfill drains. See
   * FaceClusterEngine.reapplyVerdicts — this is what makes a manual correction
   * outlive a library-wide re-cluster.
   */
  async reapplyFaceVerdicts(): Promise<number> {
    const reapplied = await this.faceClusters.reapplyVerdicts();
    if (reapplied) this.layout.invalidateFaceClusterPCACache();
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
}
