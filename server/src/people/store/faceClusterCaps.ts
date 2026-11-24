import type { FaceClusterLayout } from "./faceClusterLayout.ts";
import type { FaceClusterReviewStore } from "./faceClusterReviewStore.ts";
import type { FaceClusterEdits } from "./faceClusterEdits.ts";
import { AsyncSqlite } from "../../common/asyncSqlite.ts";
import { type FaceClusterFace } from "../../indexDatabase/indexDatabase.type.ts";
import { encodeEmbedding } from "../../indexDatabase/embeddingCodec.ts";
import { FACE_CLUSTER_SIMILARITY_THRESHOLD, FaceClusterEngine, toUnitFloat32 } from "./faceClusterEngine.ts";
import { collateralOf, dot as capDot, growCapToInclude, minimalEnclosingCap, refitCaps, shrinkCapToExclude, type Cap } from "../clustering/faceGeometry.ts";
import { faceClusterIdToString, faceClusterIdFromString } from "./faceClusterId.ts";
import { faceRowToClusterFace } from "./faceRowToClusterFace.ts";

/** Changing a cluster's shape after a correction: refit, shrink, grow, start one, assign a face. */
export class FaceClusterCaps {
  constructor(
    private readonly db: AsyncSqlite,
    private readonly faceClusters: FaceClusterEngine,
    private readonly layout: FaceClusterLayout,
    private readonly review: FaceClusterReviewStore,
    private readonly edits: FaceClusterEdits,
  ) {}

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
    const resolved = await this.review.resolvePersonClusters(clusterId);
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

    this.layout.invalidateFaceClusterPCACache();
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
    const resolved = await this.review.resolvePersonClusters(clusterId);
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
    this.layout.invalidateFaceClusterPCACache();
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
    const resolved = await this.review.resolvePersonClusters(clusterId);
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
    this.layout.invalidateFaceClusterPCACache();
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
    const resolved = await this.review.resolvePersonClusters(clusterId);
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
    this.layout.invalidateFaceClusterPCACache();
    return { clusterId: faceClusterIdToString(created) };
  }

  /**
   * Moves one face to a different person — the viewer's "that's not Ada, it's
   * Bo" correction (feedback #160). Either names an existing person
   * (`personId`, any of their centroid ids) or starts a new one (`name`).
   *
   * Three steps, each reusing an existing primitive:
   * 1. Pull the face out of the cluster it is in now (`rejectFaces`), which
   *    also takes it off that cluster's running mean.
   * 2. Give it a cluster of its own under the target person. The radius is 1
   *    so the cluster accepts no further faces: this face was mis-assigned
   *    because it looks like the old person, so a cluster at the default
   *    radius would start drawing the old person's next faces to the new one.
   * 3. Record a `confirmed` verdict for the target. It replaces the
   *    `rejected` verdict from step 1 (one verdict row per face); left as
   *    `rejected`, `reapplyVerdicts` would pull the face back out of its new
   *    home after the next re-cluster.
   *
   * Returns null when the face, its embedding or the target person is missing.
   */
  async assignFaceToPerson(
    faceId: number,
    target: { personId: string } | { name: string },
  ): Promise<{ personId: string; name: string | null } | null> {
    const face = await this.db.get<{
      clusterId: number | null;
      personId: number | null;
      embedding: Buffer | null;
    }>(
      `SELECT f.clusterId AS clusterId,
              COALESCE(fc.personId, f.clusterId) AS personId,
              fe.embedding AS embedding
       FROM faces f
       LEFT JOIN faceClusters fc ON fc.id = f.clusterId
       LEFT JOIN faceEmbeddings fe ON fe.faceId = f.id
       WHERE f.id = ?`,
      faceId,
    );
    if (!face?.embedding) return null;
    const vector = toUnitFloat32(face.embedding);
    if (!vector) return null;

    let targetRoot: number | null = null;
    let newName: string | null = null;
    if ("personId" in target) {
      const resolved = await this.review.resolvePersonClusters(target.personId);
      if (!resolved) return null;
      targetRoot = resolved.root;
    } else {
      newName = target.name.trim();
      if (!newName) return null;
    }

    const inRealCluster = face.clusterId !== null && face.clusterId > 0;
    if (inRealCluster && targetRoot !== null && face.personId === targetRoot) {
      // Already theirs: the correction is just "yes, this is them".
      await this.faceClusters.confirmFaces([
        { id: faceId, clusterId: face.clusterId!, personId: targetRoot },
      ]);
      this.layout.invalidateFaceClusterPCACache();
      return this.describePerson(targetRoot);
    }

    if (inRealCluster) {
      await this.faceClusters.rejectFaces([
        {
          id: faceId,
          clusterId: face.clusterId!,
          personId: face.personId!,
          embedding: face.embedding,
        },
      ]);
    }

    const created = await this.faceClusters.createCluster(
      { centre: vector, minSimilarity: 1 },
      [faceId],
    );
    const root = targetRoot ?? created;
    await this.db.transaction([
      {
        sql: "UPDATE faceClusters SET personId = ? WHERE id = ?",
        params: [root, created],
      },
    ]);
    if (newName !== null) {
      await this.edits.renameCluster(faceClusterIdToString(created), newName);
    }
    await this.faceClusters.confirmFaces([{ id: faceId, clusterId: created, personId: root }]);
    this.layout.invalidateFaceClusterPCACache();
    return this.describePerson(root);
  }

  private async describePerson(
    root: number,
  ): Promise<{ personId: string; name: string | null }> {
    const row = await this.db.get<{ name: string | null }>(
      "SELECT name FROM faceClusters WHERE id = ?",
      root,
    );
    return { personId: faceClusterIdToString(root), name: row?.name ?? null };
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
}
