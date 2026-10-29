import { AsyncSqlite } from "../common/asyncSqlite.ts";
import { type FaceClusterFace } from "./indexDatabase.type.ts";
import { joinPath, splitPath } from "./utils/pathUtils.ts";
import { decodeEmbedding, encodeEmbedding } from "./embeddingCodec.ts";
import { FaceClusterEngine, UNCLUSTERABLE_CLUSTER_ID } from "./faceClusterEngine.ts";
import { getLogger } from "../observability/logger.ts";
import { FACE_ATTRIBUTE_VERSION } from "../faceDetection/faceAttributes.ts";
import type { FaceAttributes } from "../faceDetection/faceDetector.type.ts";
import {
  computePhotoQualityScore,
  faceAttributesToQualityInputs,
  type FaceQualityInputs,
} from "../faceDetection/photoQuality.ts";
import { clamp01 } from "../common/clamp01.ts";
import { faceClusterIdToString, faceClusterIdFromString } from "./faceClusterId.ts";
import { faceRowToClusterFace } from "./faceRowToClusterFace.ts";
import { deleteFacesStatements } from "./deleteFacesStatements.ts";

const log = getLogger("faces");

// PRAGMA user_version marking that stale per-face "photo ready" attributes have
// been reset for re-derivation at FACE_ATTRIBUTE_VERSION (see
// resetStaleFaceAttributes). Bump *both* this and FACE_ATTRIBUTE_VERSION when
// the derivation in python/face_attributes.py changes in a way that should
// invalidate existing scores.
const FACE_ATTRIBUTE_RESET_VERSION = 4;

const personIdFromName = (name: string) => {
  const normalized = name.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 1 || 1;
};

const toCenterBoxFromTopLeft = (box: {
  x: number;
  y: number;
  width: number;
  height: number;
}) => {
  const width = clamp01(box.width);
  const height = clamp01(box.height);
  const x = clamp01(box.x + width / 2);
  const y = clamp01(box.y + height / 2);
  return { x, y, width, height };
};

const normalizeCenterArea = (area: {
  x: number;
  y: number;
  width: number;
  height: number;
}) => {
  const width = clamp01(area.width);
  const height = clamp01(area.height);
  const x = clamp01(area.x);
  const y = clamp01(area.y);
  return { x, y, width, height };
};

// Face rows are stored per file; cluster ids are exposed to the client as
// opaque strings. Keep the "person-" prefix stable — it's part of the API.

/** Faces as found in each file: detections, "photo ready" attributes, and the names on them. */
export class FaceStore {
  constructor(
    private readonly db: AsyncSqlite,
    private readonly faceClusters: FaceClusterEngine,
    private readonly invalidateStatusCountsCache: () => void,
    /** Faces changed, so the People-tab layout computed from them is stale. */
    private readonly invalidateFaceClusterPCACache: () => void,
  ) {}

  /**
   * Persists face detection results for a single file: replaces any existing
   * face rows for that file with the supplied list (possibly empty) and stamps
   * `facesProcessedAt` on the files row so the orchestrator knows the image has
   * been processed.
   *
   * Storing an empty list is intentional — it represents "scanned, no faces".
   * `facesProcessedAt IS NULL` still represents "not yet scanned".
   */
  async saveFaceDetectionResult(
    relativePath: string,
    faces: Array<{
      box: { x: number; y: number; width: number; height: number };
      confidence: number;
      embedding: Float64Array;
      attributes?: FaceAttributes;
      /** Video faces only — see `faces.frameTimeMs`. */
      frameTimeMs?: number;
      /** Video faces only — see the `faceAppearances` table. */
      appearances?: ReadonlyArray<{ startMs: number; endMs: number }>;
    }>,
    detectedAt: Date = new Date(),
  ): Promise<void> {
    const { folder, fileName } = splitPath(relativePath);
    const detectedAtMs = detectedAt.getTime();

    // Re-detection replaces this file's face rows; subtract the outgoing faces
    // from their clusters' running means so the replacements don't count twice.
    await this.withdrawFaceClusterAssignments(folder, fileName);

    const statements: Array<{ sql: string; params: unknown[] }> = [
      ...deleteFacesStatements("folder = ? AND fileName = ?", [folder, fileName]),
    ];

    for (const face of faces) {
      const centeredBox = toCenterBoxFromTopLeft(face.box);
      // The detection pass derives attributes from landmarks it already ran and
      // from the image it already decoded, so they arrive with the detection and
      // never need the backfill. Stamp the version whenever attributes were
      // computed at all — even an all-unknown result is a completed attempt.
      const attributes = face.attributes;
      statements.push({
        sql: `INSERT INTO faces
                (folder, fileName, boxX, boxY, boxWidth, boxHeight, confidence, detectedAt,
                 smileScore, eyesOpenScore, focusScore, exposureScore, faceAttrVersion,
                 frameTimeMs)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          folder,
          fileName,
          centeredBox.x,
          centeredBox.y,
          centeredBox.width,
          centeredBox.height,
          face.confidence,
          detectedAtMs,
          attributes?.smile ?? null,
          attributes?.eyesOpen ?? null,
          attributes?.focus ?? null,
          attributes?.exposure ?? null,
          attributes ? FACE_ATTRIBUTE_VERSION : null,
          face.frameTimeMs ?? null,
        ],
      });
    }

    statements.push({
      sql: "UPDATE files SET facesProcessedAt = ?, facesLastErrorAt = NULL WHERE folder = ? AND fileName = ?",
      params: [detectedAtMs, folder, fileName],
    });

    // Detection replaced this file's whole face set, so its quality aggregate
    // is recomputed from the same in-memory list rather than re-reading it
    // back from the rows just written — no need to defer to the backfill or
    // pay an extra round trip. An empty/no-attribute detection correctly
    // resolves to NULL (see computePhotoQualityScore).
    statements.push({
      sql: "UPDATE files SET photoQualityScore = ? WHERE folder = ? AND fileName = ?",
      params: [
        computePhotoQualityScore(
          faces.map((face) => faceAttributesToQualityInputs(face.attributes)),
        ),
        folder,
        fileName,
      ],
    });

    await this.db.transaction(statements);

    // `faces.id` is an autoincrement rowid, so the embeddings can only be
    // written once the rows exist. The delete-then-insert above means every row
    // for this file was just created in `faces` order, so reading the ids back
    // ordered by id pairs them with the input array positionally.
    const insertedIds = await this.db.all<{ id: number }>(
      "SELECT id FROM faces WHERE folder = ? AND fileName = ? ORDER BY id",
      folder,
      fileName,
    );
    if (insertedIds.length === faces.length) {
      const perFaceStatements: Array<{ sql: string; params: unknown[] }> = [];
      faces.forEach((face, index) => {
        for (const { startMs, endMs } of face.appearances ?? []) {
          perFaceStatements.push({
            sql: "INSERT OR REPLACE INTO faceAppearances (faceId, startMs, endMs) VALUES (?, ?, ?)",
            params: [insertedIds[index].id, Math.round(startMs), Math.round(endMs)],
          });
        }
        const encoded = encodeEmbedding(face.embedding);
        if (encoded) {
          perFaceStatements.push({
            sql: "INSERT INTO faceEmbeddings (faceId, embedding) VALUES (?, ?)",
            params: [insertedIds[index].id, encoded],
          });
        } else {
          // No usable vector: stamp the sentinel so the clustering backfill
          // (which now selects purely on `clusterId IS NULL`) skips it forever.
          perFaceStatements.push({
            sql: "UPDATE faces SET clusterId = ? WHERE id = ?",
            params: [UNCLUSTERABLE_CLUSTER_ID, insertedIds[index].id],
          });
        }
      });
      if (perFaceStatements.length > 0) {
        await this.db.transaction(perFaceStatements);
      }
    } else {
      log.warn(
        { path: relativePath, inserted: insertedIds.length, expected: faces.length },
        "Face row count did not match detection count; skipping embedding and appearance write",
      );
    }

    this.invalidateFaceClusterPCACache();
    this.invalidateStatusCountsCache();

    // Assign the fresh faces to clusters right away so the People tab reflects
    // new detections without waiting for the backfill task. Best-effort: on
    // failure the rows stay clusterId NULL and the backfill picks them up.
    try {
      const inserted = await this.db.all<{
        id: number;
        embedding: Buffer;
        confidence: number | null;
      }>(
        `SELECT f.id, fe.embedding, f.confidence
         FROM faces f
         JOIN faceEmbeddings fe ON fe.faceId = f.id
         WHERE f.folder = ? AND f.fileName = ?`,
        folder,
        fileName,
      );
      await this.faceClusters.assignFaces(inserted);
    } catch (error) {
      log.warn(
        { err: error, path: relativePath },
        "Inline face cluster assignment failed; backfill will retry",
      );
    }
  }

  /**
   * Next files holding faces that have never been scored for "photo ready"
   * attributes, oldest-path first.
   *
   * Served entirely by the partial `needing_attributes` index, which only
   * contains outstanding faces — so this stays cheap as the backfill drains and
   * costs nothing once it is done. `DISTINCT ... LIMIT` over an index ordered by
   * (folder, fileName) stops after `limit` files instead of grouping the table.
   */
  async getFilesNeedingFaceAttributes(limit: number): Promise<string[]> {
    const rows = await this.db.all<{ folder: string; fileName: string }>(
      `SELECT DISTINCT folder, fileName FROM faces
       WHERE faceAttrVersion IS NULL
       LIMIT ?`,
      limit,
    );
    return rows.map((row) => joinPath(row.folder, row.fileName));
  }

  /** How many faces are still waiting for attribute derivation. */
  async countFacesNeedingAttributes(): Promise<number> {
    const row = await this.db.get<{ total: number }>(
      "SELECT COUNT(*) AS total FROM faces WHERE faceAttrVersion IS NULL",
    );
    return row?.total ?? 0;
  }

  async countFacesTotal(): Promise<number> {
    const row = await this.db.get<{ total: number }>(
      "SELECT COUNT(*) AS total FROM faces",
    );
    return row?.total ?? 0;
  }

  /**
   * The stored faces of one file, as top-left normalized boxes — the shape the
   * attribute worker wants. Deliberately does not read `embedding`, so this is
   * an index-only read.
   */
  async getFaceBoxesForAttributes(relativePath: string): Promise<
    Array<{ id: number; box: { x: number; y: number; width: number; height: number } }>
  > {
    const { folder, fileName } = splitPath(relativePath);
    const rows = await this.db.all<{
      id: number;
      boxX: number;
      boxY: number;
      boxWidth: number;
      boxHeight: number;
    }>(
      `SELECT id, boxX, boxY, boxWidth, boxHeight FROM faces
       WHERE folder = ? AND fileName = ? AND faceAttrVersion IS NULL`,
      folder,
      fileName,
    );
    return rows.map((row) => ({
      id: row.id,
      // Stored boxes are centre-based; the worker (like the detector) speaks
      // top-left.
      box: {
        x: row.boxX - row.boxWidth / 2,
        y: row.boxY - row.boxHeight / 2,
        width: row.boxWidth,
        height: row.boxHeight,
      },
    }));
  }

  /**
   * Writes derived attributes onto existing face rows by id.
   *
   * Never touches clusterId/embedding, so backfilling attributes cannot disturb
   * People clustering. `faceAttrVersion` is stamped for every id passed in —
   * including faces every attribute came back unknown for — so an unjudgeable
   * face leaves the queue instead of being retried on every pass.
   */
  async saveFaceAttributes(
    results: Array<{ id: number; attributes: FaceAttributes }>,
  ): Promise<void> {
    if (results.length === 0) return;
    await this.db.transaction(
      results.map(({ id, attributes }) => ({
        sql: `UPDATE faces
              SET smileScore = ?, eyesOpenScore = ?, focusScore = ?, exposureScore = ?,
                  faceAttrVersion = ?
              WHERE id = ?`,
        params: [
          attributes.smile ?? null,
          attributes.eyesOpen ?? null,
          attributes.focus ?? null,
          attributes.exposure ?? null,
          FACE_ATTRIBUTE_VERSION,
          id,
        ],
      })),
    );

    // The backfill scores faces in id batches that may span several files
    // (unlike saveFaceDetectionResult, which already has one file's whole face
    // set in memory), so the affected files have to be looked up here instead.
    await this.recomputePhotoQualityScoreForFaces(results.map(({ id }) => id));
  }

  /**
   * Recomputes and stores `files.photoQualityScore` for every file that owns
   * any of the given face ids, from that file's currently-scored faces. Safe
   * to call after any write to the attribute columns — it always reflects
   * whatever has been scored so far, converging as the backfill drains rather
   * than needing to be "done" up front.
   */
  private async recomputePhotoQualityScoreForFaces(faceIds: number[]): Promise<void> {
    if (faceIds.length === 0) return;

    const placeholders = faceIds.map(() => "?").join(", ");
    const affectedFiles = await this.db.all<{ folder: string; fileName: string }>(
      `SELECT DISTINCT folder, fileName FROM faces WHERE id IN (${placeholders})`,
      ...faceIds,
    );

    for (const { folder, fileName } of affectedFiles) {
      // Only faces that have actually been scored (faceAttrVersion IS NOT
      // NULL) contribute — an unscored sibling face contributes no
      // information yet, same as if it weren't detected at all.
      const faceRows = await this.db.all<FaceQualityInputs>(
        `SELECT smileScore, eyesOpenScore, focusScore, exposureScore FROM faces
         WHERE folder = ? AND fileName = ? AND faceAttrVersion IS NOT NULL`,
        folder,
        fileName,
      );
      await this.db.run(
        "UPDATE files SET photoQualityScore = ? WHERE folder = ? AND fileName = ?",
        computePhotoQualityScore(faceRows),
        folder,
        fileName,
      );
    }
  }

  /**
   * Subtracts a file's clustered faces from their clusters ahead of deleting
   * the face rows. Best-effort: a missed withdrawal only leaves ghost weight in
   * a centroid (displayed counts always come from live rows).
   */
  private async withdrawFaceClusterAssignments(
    folder: string,
    fileName: string,
  ): Promise<void> {
    try {
      const assigned = await this.db.all<{ clusterId: number; embedding: Buffer }>(
        `SELECT f.clusterId, fe.embedding FROM faces f
         JOIN faceEmbeddings fe ON fe.faceId = f.id
         WHERE f.folder = ? AND f.fileName = ? AND f.clusterId IS NOT NULL`,
        folder,
        fileName,
      );
      await this.faceClusters.removeFaces(assigned);
    } catch (error) {
      log.warn(
        { err: error, folder, fileName },
        "Face cluster withdrawal failed; centroids keep ghost weight",
      );
    }
  }

  async saveFacesFromMetadataRegions(
    relativePath: string,
    regions: Array<{
      name?: string;
      area?: { x: number; y: number; width: number; height: number };
    }>,
    detectedAt: Date = new Date(),
  ): Promise<void> {
    const faces = regions
      .filter(
        (
          region,
        ): region is {
          name?: string;
          area: { x: number; y: number; width: number; height: number };
        } =>
          Boolean(region?.area) &&
          typeof region.area?.x === "number" &&
          typeof region.area?.y === "number" &&
          typeof region.area?.width === "number" &&
          typeof region.area?.height === "number" &&
          region.area.width > 0 &&
          region.area.height > 0,
      )
      .map((region) => ({
        box: normalizeCenterArea(region.area),
        personId: typeof region.name === "string" ? personIdFromName(region.name) : null,
      }));

    if (!faces.length) {
      return;
    }

    const { folder, fileName } = splitPath(relativePath);
    const detectedAtMs = detectedAt.getTime();

    await this.withdrawFaceClusterAssignments(folder, fileName);

    const statements: Array<{ sql: string; params: unknown[] }> = [
      ...deleteFacesStatements("folder = ? AND fileName = ?", [folder, fileName]),
      ...faces.map((face) => ({
        // Faces named by EXIF regions carry no recognition vector, so they get
        // no faceEmbeddings row. UNCLUSTERABLE is what keeps the clustering
        // backfill — which now selects on clusterId alone — from picking them up
        // forever; the old `LENGTH(embedding) > 0` filter used to do that job.
        sql: `INSERT INTO faces
                (folder, fileName, boxX, boxY, boxWidth, boxHeight, confidence, personId, detectedAt, clusterId)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          folder,
          fileName,
          face.box.x,
          face.box.y,
          face.box.width,
          face.box.height,
          1,
          face.personId,
          detectedAtMs,
          UNCLUSTERABLE_CLUSTER_ID,
        ],
      })),
      {
        sql: "UPDATE files SET facesProcessedAt = ? WHERE folder = ? AND fileName = ?",
        params: [detectedAtMs, folder, fileName],
      },
    ];

    await this.db.transaction(statements);
    this.invalidateFaceClusterPCACache();
    this.invalidateStatusCountsCache();
  }

  /** Returns face rows for a file in insertion order. Empty array means scanned-no-faces. */
  async getFacesForFile(relativePath: string): Promise<
    Array<{
      id: number;
      box: { x: number; y: number; width: number; height: number };
      confidence: number;
      embedding: Float64Array;
      personId: number | null;
      detectedAt: number;
    }>
  > {
    const { folder, fileName } = splitPath(relativePath);
    const rows = await this.db.all<{
      id: number;
      boxX: number;
      boxY: number;
      boxWidth: number;
      boxHeight: number;
      confidence: number;
      embedding: Buffer;
      personId: number | null;
      detectedAt: number;
    }>(
      `SELECT f.id, f.boxX, f.boxY, f.boxWidth, f.boxHeight, f.confidence,
              fe.embedding, f.personId, f.detectedAt
       FROM faces f
       LEFT JOIN faceEmbeddings fe ON fe.faceId = f.id
       WHERE f.folder = ? AND f.fileName = ?
       ORDER BY f.id`,
      folder,
      fileName,
    );

    return rows.map((row) => {
      // The stored form is int8 (see embeddingCodec.ts); the codec decodes it —
      // and any legacy blob — to a Float32 unit vector. This signature stays
      // Float64 for its callers, so widen on the way out. The LEFT JOIN means a
      // face with no embedding row yields an empty vector rather than throwing.
      const unit = decodeEmbedding(row.embedding);
      return {
        id: row.id,
        box: {
          x: row.boxX,
          y: row.boxY,
          width: row.boxWidth,
          height: row.boxHeight,
        },
        confidence: row.confidence,
        embedding: unit ? Float64Array.from(unit) : new Float64Array(0),
        personId: row.personId,
        detectedAt: row.detectedAt,
      };
    });
  }

  /**
   * Returns the detected faces for a file joined to their People cluster, for
   * the fullscreen face-name overlay. Only faces assigned to a real cluster
   * (`clusterId > 0`) are returned; each carries the effective person id (after
   * merges, via `COALESCE(faceClusters.personId, faces.clusterId)`) and that
   * person's name when the user has named them. Boxes are normalized centre
   * coordinates, matching `faceTableBoxes` on the client.
   */
  async getPeopleFacesForFile(relativePath: string): Promise<
    Array<{
      faceId: number;
      box: { x: number; y: number; width: number; height: number };
      personId: string;
      name: string | null;
      /** Video faces only: the frame the box is on. */
      frameTimeMs?: number;
      /** Video faces only: when this person is on screen, earliest first. */
      appearances?: Array<{ startMs: number; endMs: number }>;
    }>
  > {
    const { folder, fileName } = splitPath(relativePath);
    const rows = await this.db.all<{
      id: number;
      boxX: number;
      boxY: number;
      boxWidth: number;
      boxHeight: number;
      personId: number;
      name: string | null;
      frameTimeMs: number | null;
    }>(
      `SELECT
         faces.id,
         faces.boxX,
         faces.boxY,
         faces.boxWidth,
         faces.boxHeight,
         COALESCE(cluster.personId, faces.clusterId) AS personId,
         person.name AS name,
         faces.frameTimeMs
       FROM faces
       LEFT JOIN faceClusters AS cluster ON cluster.id = faces.clusterId
       LEFT JOIN faceClusters AS person
         ON person.id = COALESCE(cluster.personId, faces.clusterId)
       WHERE faces.folder = ? AND faces.fileName = ? AND faces.clusterId > 0
       ORDER BY faces.id`,
      folder,
      fileName,
    );
    // Only video faces have appearances, so a photo skips the lookup.
    const appearances = rows.some((row) => typeof row.frameTimeMs === "number")
      ? await this.getFaceAppearances(rows.map((row) => row.id))
      : new Map<number, Array<{ startMs: number; endMs: number }>>();

    return rows.map((row) => ({
      faceId: row.id,
      box: {
        x: row.boxX,
        y: row.boxY,
        width: row.boxWidth,
        height: row.boxHeight,
      },
      personId: faceClusterIdToString(row.personId),
      name: row.name,
      ...(typeof row.frameTimeMs === "number" ? { frameTimeMs: row.frameTimeMs } : {}),
      ...(appearances.has(row.id) ? { appearances: appearances.get(row.id) } : {}),
    }));
  }

  /**
   * When each of these faces is on screen, earliest first, keyed by face id.
   * Faces from stills have no rows and are absent from the map.
   */
  async getFaceAppearances(
    faceIds: readonly number[],
  ): Promise<Map<number, Array<{ startMs: number; endMs: number }>>> {
    const result = new Map<number, Array<{ startMs: number; endMs: number }>>();
    // Chunked to stay well under SQLite's bound-parameter limit.
    for (let i = 0; i < faceIds.length; i += 500) {
      const chunk = faceIds.slice(i, i + 500);
      const rows = await this.db.all<{ faceId: number; startMs: number; endMs: number }>(
        `SELECT faceId, startMs, endMs FROM faceAppearances
         WHERE faceId IN (${chunk.map(() => "?").join(",")})
         ORDER BY faceId, startMs`,
        ...chunk,
      );
      for (const { faceId, startMs, endMs } of rows) {
        const list = result.get(faceId) ?? [];
        list.push({ startMs, endMs });
        result.set(faceId, list);
      }
    }
    return result;
  }

  /**
   * A handful of *other* sightings of this same clustered person, for the
   * fullscreen face-assign panel's "does this look right?" preview before
   * naming/merging an unnamed cluster. Deliberately much cheaper than
   * `getFaceClusterDetail`: no filter/count/centroid/merge-suggestion work,
   * just the top-N members by `clusterSimilarity` (the same ranking the
   * People tab uses to pick a representative). `excludeFaceId` leaves out
   * the face the panel was opened from, so the preview shows other photos
   * rather than repeating the one already on screen.
   */
  async getClusterFacePreview(
    clusterId: string,
    options: { limit?: number; excludeFaceId?: number } = {},
  ): Promise<FaceClusterFace[]> {
    const numericId = faceClusterIdFromString(clusterId);
    if (numericId === null || numericId <= 0) return [];
    const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 6) || 6, 50));

    const params: unknown[] = [numericId];
    let excludeClause = "";
    if (typeof options.excludeFaceId === "number" && Number.isFinite(options.excludeFaceId)) {
      excludeClause = "AND faces.id != ?";
      params.push(options.excludeFaceId);
    }

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
      `SELECT
         faces.id,
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
       JOIN faceClusters ON faceClusters.id = faces.clusterId
       JOIN files
         ON files.folder = faces.folder AND files.fileName = faces.fileName
       WHERE faces.clusterId > 0
         AND COALESCE(faceClusters.personId, faces.clusterId) = ?
         ${excludeClause}
       ORDER BY faces.clusterSimilarity DESC, faces.id
       LIMIT ${limit}`,
      ...params,
    );

    return rows.map(faceRowToClusterFace);
  }

  /**
   * Every currently-named person, for the face-assign panel's "type an
   * existing name" autocomplete. Only a canonical/root cluster row ever
   * carries a name: `renameCluster` always writes it onto the effective
   * root, and `mergeClusters` immediately nulls it off any row it merges
   * away — so a plain `name IS NOT NULL` is sufficient (no need to also
   * check `personId`, which points at the row's *own* id for a named,
   * never-merged root rather than staying NULL — see renameCluster). This
   * stays a small result set (dozens, not the library's full cluster count)
   * regardless of how many total face clusters exist.
   */
  async listNamedPeople(): Promise<Array<{ id: string; name: string }>> {
    const rows = await this.db.all<{ id: number; name: string }>(
      `SELECT id, name FROM faceClusters
       WHERE name IS NOT NULL
       ORDER BY name COLLATE NOCASE`,
    );
    return rows.map((row) => ({ id: faceClusterIdToString(row.id), name: row.name }));
  }

  /**
   * Display names for the given face-cluster ids, resolved through merges the
   * same way `getPeopleFacesForFile` does. Unnamed clusters are omitted.
   */
  async getFaceClusterNames(clusterIds: number[]): Promise<Map<number, string>> {
    if (clusterIds.length === 0) return new Map();
    const rows = await this.db.all<{ id: number; name: string | null }>(
      `SELECT cluster.id AS id, person.name AS name
         FROM faceClusters AS cluster
         LEFT JOIN faceClusters AS person
           ON person.id = COALESCE(cluster.personId, cluster.id)
        WHERE cluster.id IN (${clusterIds.map(() => "?").join(", ")})`,
      ...clusterIds,
    );
    return new Map(
      rows.flatMap((row) =>
        row.name ? ([[row.id, row.name]] as [number, string][]) : [],
      ),
    );
  }

  /**
   * Distinct *named* people per file, keyed by `folder + fileName`. Ranks
   * share-preview candidates: among equally-rated photos, one with several
   * recognized people makes a better link thumbnail than a landscape.
   */
  async countNamedPeopleForFiles(
    files: Array<{ folder: string; fileName: string }>,
  ): Promise<Map<string, number>> {
    if (files.length === 0) return new Map();
    const rows = await this.db.all<{ folder: string; fileName: string; count: number }>(
      `SELECT faces.folder AS folder,
              faces.fileName AS fileName,
              COUNT(DISTINCT COALESCE(cluster.personId, faces.clusterId)) AS count
         FROM faces
         JOIN faceClusters AS cluster ON cluster.id = faces.clusterId
         JOIN faceClusters AS person
           ON person.id = COALESCE(cluster.personId, faces.clusterId)
        WHERE person.name IS NOT NULL
          AND (${files.map(() => "(faces.folder = ? AND faces.fileName = ?)").join(" OR ")})
        GROUP BY faces.folder, faces.fileName`,
      ...files.flatMap(({ folder, fileName }) => [folder, fileName]),
    );
    return new Map(rows.map((row) => [row.folder + row.fileName, row.count]));
  }

  /**
   * One-time migration (gated by PRAGMA user_version) that returns faces scored
   * by a *superseded* attribute derivation to the backfill queue.
   *
   * Adding the attribute columns themselves needs no migration — prepareTables
   * ALTERs them in as NULL, which already reads as "never scored" and is picked
   * up incrementally by the attribute task. This step exists for the other case:
   * when `FACE_ATTRIBUTE_VERSION` is bumped because the derivation improved,
   * rows carrying the old version must go back on the queue. Clearing the
   * version (rather than the scores) leaves the old values readable until the
   * new ones land, so the filter keeps working during the re-derivation.
   *
   * On a fresh install and on the first release of the feature this matches no
   * rows and is a no-op. Idempotent: a re-run finds nothing below the current
   * version.
   */
  async resetStaleFaceAttributes(): Promise<void> {
    const versionRow = await this.db.get<{ user_version: number }>(
      "PRAGMA user_version",
    );
    if ((versionRow?.user_version ?? 0) >= FACE_ATTRIBUTE_RESET_VERSION) return;

    const result = await this.db.run(
      "UPDATE faces SET faceAttrVersion = NULL WHERE faceAttrVersion < ?",
      FACE_ATTRIBUTE_VERSION,
    );

    await this.db.exec(`PRAGMA user_version = ${FACE_ATTRIBUTE_RESET_VERSION}`);
    log.info(
      { requeued: result?.changes ?? 0, version: FACE_ATTRIBUTE_VERSION },
      "Re-queued faces for photo-ready attribute derivation",
    );
  }

}
