import { AsyncSqlite } from "../common/asyncSqlite.ts";
import { joinPath, splitPath } from "./utils/pathUtils.ts";
import { encodeEmbedding } from "./embeddingCodec.ts";
import { AnalysisSearch } from "./analysisSearch.ts";
import { VectorIndex } from "./vectorIndex/vectorIndex.ts";
import { decodeVideoFrameEmbeddings, encodeVideoFrameEmbeddings } from "./videoFrameEmbeddingCodec.ts";

/** What the index knows about a video that prices it for the face pass (see videoFaceAnalysis/videoFaceCost.ts). */
export type VideoFaceCostInputs = {
  durationSeconds?: number;
  sizeBytes?: number;
  width?: number;
  height?: number;
};

/** A video waiting for the face pass, with what ordering it needs. */
export type QueuedVideoFaces = { relativePath: string } & VideoFaceCostInputs & {
    /** ms since epoch: date taken, else file creation. */
    takenAt?: number;
    /** It failed once and came back after the retry cooldown. */
    failedBefore: boolean;
  };

/** A queued video and which of the video pass's two results it still lacks. */
export type QueuedVideoAnalysis = QueuedVideoFaces & {
  needsFaces: boolean;
  /** CLIP vectors for its frames, for search (feedback #150). */
  needsEmbedding: boolean;
};

const finiteOrUndefined = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const toVideoFaceCostInputs = (row: Record<string, unknown>): VideoFaceCostInputs => ({
  durationSeconds: finiteOrUndefined(row.duration),
  sizeBytes: finiteOrUndefined(row.sizeInBytes),
  width: finiteOrUndefined(row.dimensionsWidth),
  height: finiteOrUndefined(row.dimensionsHeight),
});

/** Per-file analysis results (CLIP and CLAP embeddings, transcripts) and the searches over them. */
export class AnalysisStore {
  private readonly search: AnalysisSearch;

  constructor(
    private readonly db: AsyncSqlite,
    private readonly vectorIndex: VectorIndex,
  ) {
    this.search = new AnalysisSearch(db, vectorIndex);
  }

  async getFilesNeedingEmbedding(
    limit = 50,
  ): Promise<Array<{ relativePath: string; mimeType: string | null }>> {
    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT folder, fileName, mimeType FROM files
       WHERE (mimeType LIKE 'image/%')
         AND embeddingProcessedAt IS NULL
         AND infoProcessedAt IS NOT NULL
       ORDER BY embeddingErrorAt IS NOT NULL, embeddingErrorAt, folder, fileName
       LIMIT ?`,
      limit,
    );
    return rows.map((row) => ({
      relativePath: joinPath(row.folder as string, row.fileName as string),
      mimeType: (row.mimeType as string | null) ?? null,
    }));
  }

  async saveImageEmbedding(relativePath: string, embedding: Float32Array): Promise<void> {
    const { folder, fileName } = splitPath(relativePath);
    const encoded = encodeEmbedding(embedding);
    await this.db.transaction([
      {
        sql: `INSERT INTO fileEmbeddings (folder, fileName, imageEmbedding)
              VALUES (?, ?, ?)
              ON CONFLICT(folder, fileName) DO UPDATE SET imageEmbedding = excluded.imageEmbedding`,
        params: [folder, fileName, encoded],
      },
      {
        // The pipeline markers stay on `files`; only the vector moved.
        sql: `UPDATE files
              SET embeddingProcessedAt = ?, embeddingErrorAt = NULL
              WHERE folder = ? AND fileName = ?`,
        params: [Date.now(), folder, fileName],
      },
    ]);
    if (encoded) await this.vectorIndex.upsert("image", { folder, fileName }, encoded);
  }

  async saveImageEmbeddingError(relativePath: string): Promise<void> {
    const { folder, fileName } = splitPath(relativePath);
    await this.db.run(
      `UPDATE files SET embeddingErrorAt = ? WHERE folder = ? AND fileName = ?`,
      Date.now(),
      folder,
      fileName,
    );
  }

  /** Record a permanent decode failure so this image is never re-queued for analysis. */
  async saveImageAnalysisDecodeError(relativePath: string): Promise<void> {
    const { folder, fileName } = splitPath(relativePath);
    await this.db.run(
      `UPDATE files SET analysisDecodeErrorAt = ? WHERE folder = ? AND fileName = ?`,
      Date.now(),
      folder,
      fileName,
    );
  }

  /**
   * Images that still need face detection and/or semantic embedding, with a
   * per-row flag for each. A file is only flagged for a stage once its
   * prerequisite metadata exists (EXIF for faces, file info for embeddings), so
   * the combined worker is asked to compute exactly the parts that are missing
   * and never recomputes work that is already stored.
   */
  async getImagesNeedingAnalysis(
    limit = 50,
  ): Promise<
    Array<{ relativePath: string; needsFaces: boolean; needsEmbedding: boolean }>
  > {
    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT folder, fileName,
         CASE WHEN facesProcessedAt IS NULL AND exifProcessedAt IS NOT NULL THEN 1 ELSE 0 END AS needsFaces,
         CASE WHEN embeddingProcessedAt IS NULL AND infoProcessedAt IS NOT NULL THEN 1 ELSE 0 END AS needsEmbedding
       FROM files
       WHERE mimeType LIKE 'image/%'
         AND analysisDecodeErrorAt IS NULL
         AND (
           (facesProcessedAt IS NULL AND exifProcessedAt IS NOT NULL)
           OR (embeddingProcessedAt IS NULL AND infoProcessedAt IS NOT NULL)
         )
       ORDER BY (facesLastErrorAt IS NOT NULL OR embeddingErrorAt IS NOT NULL),
                dateTaken DESC NULLS LAST,
                folder DESC, fileName DESC
       LIMIT ?`,
      limit,
    );
    return rows.map((row) => ({
      relativePath: joinPath(row.folder as string, row.fileName as string),
      needsFaces: row.needsFaces === 1,
      needsEmbedding: row.needsEmbedding === 1,
    }));
  }

  /**
   * A failed video is not retried for this long. Every attempt reads the video
   * off the media share, so retrying failures in a loop turns a few bad files
   * into terabytes of reads — the audio-transcription queue did exactly that
   * when its only backoff was an ORDER BY.
   */
  static readonly VIDEO_FACE_RETRY_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1_000;

  /**
   * Videos the video pass still has work on: faces, or CLIP vectors for their
   * frames (feedback #150; `embeddingProcessedAt`, which marks a photo's CLIP
   * vector, marks a video's frame vectors). Leaves out the movie half of a
   * Live Photo pair: its still already carries those faces and that search
   * match, so scanning it too would show everything twice.
   */
  private static readonly VIDEOS_NEEDING_FACES_WHERE = `
         mimeType LIKE 'video/%'
         AND (facesProcessedAt IS NULL OR embeddingProcessedAt IS NULL)
         AND analysisDecodeErrorAt IS NULL
         AND exifProcessedAt IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM files AS still
           WHERE still.folder = files.folder
             AND still.livePhotoVideoFileName = files.fileName
         )`;

  /**
   * Every video the face pass can take now, with what it needs to order them:
   * cost inputs, when it was taken, and whether it failed before. The runner
   * picks the order (videoFaceCost.ts `orderVideoFaceQueue`), so the cost
   * model lives in one place rather than a second copy in SQL.
   */
  async getVideosNeedingFaceAnalysis(limit?: number): Promise<QueuedVideoAnalysis[]> {
    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT folder, fileName, ${AnalysisStore.VIDEO_FACE_COST_COLUMNS},
              COALESCE(dateTaken, created) AS takenAt,
              facesLastErrorAt IS NOT NULL AS failedBefore,
              facesProcessedAt IS NULL AS needsFaces,
              embeddingProcessedAt IS NULL AS needsEmbedding
       FROM files
       WHERE ${AnalysisStore.VIDEOS_NEEDING_FACES_WHERE}
         AND (facesLastErrorAt IS NULL OR facesLastErrorAt < ?)
       ORDER BY facesLastErrorAt IS NOT NULL, dateTaken DESC NULLS LAST,
                folder DESC, fileName DESC
       ${limit === undefined ? "" : "LIMIT ?"}`,
      Date.now() - AnalysisStore.VIDEO_FACE_RETRY_COOLDOWN_MS,
      ...(limit === undefined ? [] : [limit]),
    );
    return rows.map((row) => ({
      relativePath: joinPath(row.folder as string, row.fileName as string),
      ...toVideoFaceCostInputs(row),
      takenAt: finiteOrUndefined(row.takenAt),
      failedBefore: row.failedBefore === 1,
      needsFaces: row.needsFaces === 1,
      needsEmbedding: row.needsEmbedding === 1,
    }));
  }

  /**
   * Stores the CLIP vectors of a video's sampled frames (feedback #150) and
   * marks the video's frames as embedded. A video with no usable frame is
   * marked too, so it isn't read again for nothing.
   */
  async saveVideoFrameEmbeddings(
    relativePath: string,
    frames: ReadonlyArray<{ timeMs: number; embedding: Float32Array }>,
  ): Promise<void> {
    const { folder, fileName } = splitPath(relativePath);
    const encoded = encodeVideoFrameEmbeddings(frames);
    await this.db.transaction([
      {
        sql: `INSERT INTO fileEmbeddings (folder, fileName, videoFrameEmbeddings)
              VALUES (?, ?, ?)
              ON CONFLICT(folder, fileName) DO UPDATE SET videoFrameEmbeddings = excluded.videoFrameEmbeddings`,
        params: [folder, fileName, encoded],
      },
      {
        sql: `UPDATE files
              SET embeddingProcessedAt = ?, embeddingErrorAt = NULL
              WHERE folder = ? AND fileName = ?`,
        params: [Date.now(), folder, fileName],
      },
    ]);
    await this.vectorIndex.upsertFrames({ folder, fileName }, decodeVideoFrameEmbeddings(encoded));
  }

  /** What the video-face ETA needs to know about a video. */
  private static readonly VIDEO_FACE_COST_COLUMNS =
    "duration, sizeInBytes, dimensionsWidth, dimensionsHeight";

  /**
   * Cost inputs for every video this run will still process: queued and not
   * cooling down after a failure. For the ETA, which prices each video by its
   * length, size and resolution rather than counting them as equal.
   */
  async getVideoFaceQueueCostInputs(): Promise<VideoFaceCostInputs[]> {
    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT ${AnalysisStore.VIDEO_FACE_COST_COLUMNS} FROM files
       WHERE ${AnalysisStore.VIDEOS_NEEDING_FACES_WHERE}
         AND (facesLastErrorAt IS NULL OR facesLastErrorAt < ?)`,
      Date.now() - AnalysisStore.VIDEO_FACE_RETRY_COOLDOWN_MS,
    );
    return rows.map(toVideoFaceCostInputs);
  }

  /** Starts the retry cooldown for a video whose face pass failed. */
  async saveVideoFaceAnalysisError(relativePath: string): Promise<void> {
    const { folder, fileName } = splitPath(relativePath);
    await this.db.run(
      "UPDATE files SET facesLastErrorAt = ? WHERE folder = ? AND fileName = ?",
      Date.now(),
      folder,
      fileName,
    );
  }

  /**
   * `remaining` counts videos still queued, including `coolingDown`: ones that
   * failed and wait out the retry cooldown. `unreadable` were dropped for good
   * (ffmpeg found no frame) and are in neither count.
   */
  async getVideoFaceAnalysisProgress(): Promise<{
    total: number;
    /** Videos the face pass has finished. */
    done: number;
    remaining: number;
    coolingDown: number;
    /** When the first cooling-down video becomes due again; null if none is. */
    nextRetryAt: number | null;
    unreadable: number;
  }> {
    const cooldownStart = Date.now() - AnalysisStore.VIDEO_FACE_RETRY_COOLDOWN_MS;
    const row = await this.db.get<{
      total: number;
      done: number;
      remaining: number;
      coolingDown: number;
      firstErrorAt: number | null;
      unreadable: number;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM files WHERE mimeType LIKE 'video/%') AS total,
         (SELECT COUNT(*) FROM files WHERE mimeType LIKE 'video/%'
            AND facesProcessedAt IS NOT NULL AND embeddingProcessedAt IS NOT NULL) AS done,
         (SELECT COUNT(*) FROM files WHERE ${AnalysisStore.VIDEOS_NEEDING_FACES_WHERE}) AS remaining,
         (SELECT COUNT(*) FROM files WHERE ${AnalysisStore.VIDEOS_NEEDING_FACES_WHERE}
            AND facesLastErrorAt >= ?) AS coolingDown,
         (SELECT MIN(facesLastErrorAt) FROM files WHERE ${AnalysisStore.VIDEOS_NEEDING_FACES_WHERE}
            AND facesLastErrorAt >= ?) AS firstErrorAt,
         (SELECT COUNT(*) FROM files WHERE mimeType LIKE 'video/%'
            AND (facesProcessedAt IS NULL OR embeddingProcessedAt IS NULL)
            AND analysisDecodeErrorAt IS NOT NULL) AS unreadable`,
      cooldownStart,
      cooldownStart,
    );
    const firstErrorAt = row?.firstErrorAt ?? null;
    return {
      total: row?.total ?? 0,
      done: row?.done ?? 0,
      remaining: row?.remaining ?? 0,
      coolingDown: row?.coolingDown ?? 0,
      nextRetryAt:
        firstErrorAt === null
          ? null
          : Number(firstErrorAt) + AnalysisStore.VIDEO_FACE_RETRY_COOLDOWN_MS,
      unreadable: row?.unreadable ?? 0,
    };
  }

  /** True when images exist that are waiting for upstream EXIF/info tasks to run before analysis can start. */
  async hasImagesPendingAnalysisPrerequisites(): Promise<boolean> {
    const row = await this.db.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM files
       WHERE mimeType LIKE 'image/%'
         AND (
           (facesProcessedAt IS NULL AND exifProcessedAt IS NULL)
           OR (embeddingProcessedAt IS NULL AND infoProcessedAt IS NULL)
         )`,
    );
    return (row?.count ?? 0) > 0;
  }

  async getEmbeddingProgress(): Promise<[total: number, done: number]> {
    const row = await this.db.get<{ total: number | null; done: number | null }>(
      `SELECT
         SUM(CASE WHEN mimeType LIKE 'image/%' AND infoProcessedAt IS NOT NULL THEN 1 ELSE 0 END) AS total,
         SUM(CASE WHEN mimeType LIKE 'image/%' AND embeddingProcessedAt IS NOT NULL THEN 1 ELSE 0 END) AS done
       FROM files`,
    );
    return [row?.total ?? 0, row?.done ?? 0];
  }

  // ---------------------------------------------------------------------------
  // Audio transcription (Whisper)
  // ---------------------------------------------------------------------------

  // A file that has already failed is not retried until this much time has
  // passed. Without it, de-prioritising failures (the ORDER BY below) is only a
  // throttle while unattempted work still exists: once the queue drains down to
  // nothing but permanent failures, "back of the queue" is also the front, and
  // they are re-attempted back to back forever. Every attempt streams the whole
  // source file off the media share, so a handful of large videos that can
  // never succeed produced terabytes a day of pointless network reads.
  static readonly AUDIO_TRANSCRIBE_RETRY_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1_000;

  async getFilesNeedingAudioTranscription(
    limit = 10,
  ): Promise<Array<{ relativePath: string; durationSeconds?: number }>> {
    const retryBefore =
      Date.now() - AnalysisStore.AUDIO_TRANSCRIBE_RETRY_COOLDOWN_MS;
    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT folder, fileName, duration FROM files
       WHERE exifProcessedAt IS NOT NULL
         AND audioTranscribedAt IS NULL
         AND (
           (mimeType LIKE 'video/%' AND audioCodec IS NOT NULL)
           OR mimeType LIKE 'audio/%'
         )
         AND (audioTranscribeErrorAt IS NULL OR audioTranscribeErrorAt < ?)
       ORDER BY audioTranscribeErrorAt IS NOT NULL, audioTranscribeErrorAt, folder, fileName
       LIMIT ?`,
      retryBefore,
      limit,
    );
    return rows.map((row) => ({
      relativePath: joinPath(row.folder as string, row.fileName as string),
      durationSeconds: typeof row.duration === "number" ? row.duration : undefined,
    }));
  }

  async saveAudioTranscription(
    relativePath: string,
    segments: Array<{ start: number; end: number; text: string }>,
  ): Promise<void> {
    const { folder, fileName } = splitPath(relativePath);
    const fullText = segments.map((s) => s.text).join(" ");
    const now = Date.now();

    await this.db.transaction([
      {
        sql: `UPDATE files
              SET audioTranscript = ?, audioTranscribedAt = ?, audioTranscribeErrorAt = NULL
              WHERE folder = ? AND fileName = ?`,
        params: [fullText, now, folder, fileName],
      },
      {
        sql: `DELETE FROM audioSegments WHERE folder = ? AND fileName = ?`,
        params: [folder, fileName],
      },
      ...segments.map((seg) => ({
        sql: `INSERT INTO audioSegments (folder, fileName, startTime, endTime, text)
              VALUES (?, ?, ?, ?, ?)`,
        params: [folder, fileName, seg.start, seg.end, seg.text],
      })),
    ]);
  }

  async getAudioSegments(
    relativePath: string,
  ): Promise<Array<{ start: number; end: number; text: string }>> {
    const { folder, fileName } = splitPath(relativePath);
    const rows = await this.db.all<{ startTime: number; endTime: number; text: string }>(
      `SELECT startTime, endTime, text FROM audioSegments
       WHERE folder = ? AND fileName = ?
       ORDER BY startTime`,
      folder,
      fileName,
    );
    return rows.map((row) => ({
      start: row.startTime,
      end: row.endTime,
      text: row.text,
    }));
  }

  async saveAudioTranscriptionError(relativePath: string): Promise<void> {
    const { folder, fileName } = splitPath(relativePath);
    await this.db.run(
      `UPDATE files SET audioTranscribeErrorAt = ? WHERE folder = ? AND fileName = ?`,
      Date.now(),
      folder,
      fileName,
    );
  }

  async getAudioTranscriptionProgress(): Promise<[total: number, done: number]> {
    const row = await this.db.get<{ total: number | null; done: number | null }>(
      `SELECT
         SUM(CASE WHEN exifProcessedAt IS NOT NULL AND (
           (mimeType LIKE 'video/%' AND audioCodec IS NOT NULL) OR mimeType LIKE 'audio/%'
         ) THEN 1 ELSE 0 END) AS total,
         SUM(CASE WHEN audioTranscribedAt IS NOT NULL THEN 1 ELSE 0 END) AS done
       FROM files`,
    );
    return [row?.total ?? 0, row?.done ?? 0];
  }

  // ---------------------------------------------------------------------------
  // Audio embeddings (CLAP)
  // ---------------------------------------------------------------------------

  async getFilesNeedingAudioEmbedding(
    limit = 10,
  ): Promise<Array<{ relativePath: string }>> {
    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT folder, fileName FROM files
       WHERE exifProcessedAt IS NOT NULL
         AND audioEmbeddingProcessedAt IS NULL
         AND (
           (mimeType LIKE 'video/%' AND audioCodec IS NOT NULL)
           OR mimeType LIKE 'audio/%'
         )
       ORDER BY audioEmbeddingErrorAt IS NOT NULL, audioEmbeddingErrorAt, folder, fileName
       LIMIT ?`,
      limit,
    );
    return rows.map((row) => ({
      relativePath: joinPath(row.folder as string, row.fileName as string),
    }));
  }

  async saveAudioEmbedding(relativePath: string, embedding: Float32Array): Promise<void> {
    const { folder, fileName } = splitPath(relativePath);
    const encoded = encodeEmbedding(embedding);
    await this.db.transaction([
      {
        sql: `INSERT INTO fileEmbeddings (folder, fileName, audioEmbedding)
              VALUES (?, ?, ?)
              ON CONFLICT(folder, fileName) DO UPDATE SET audioEmbedding = excluded.audioEmbedding`,
        params: [folder, fileName, encoded],
      },
      {
        sql: `UPDATE files
              SET audioEmbeddingProcessedAt = ?, audioEmbeddingErrorAt = NULL
              WHERE folder = ? AND fileName = ?`,
        params: [Date.now(), folder, fileName],
      },
    ]);
    if (encoded) await this.vectorIndex.upsert("audio", { folder, fileName }, encoded);
  }

  async saveAudioEmbeddingError(relativePath: string): Promise<void> {
    const { folder, fileName } = splitPath(relativePath);
    await this.db.run(
      `UPDATE files SET audioEmbeddingErrorAt = ? WHERE folder = ? AND fileName = ?`,
      Date.now(),
      folder,
      fileName,
    );
  }

  async markAudioEmbeddingSkipped(relativePath: string): Promise<void> {
    const { folder, fileName } = splitPath(relativePath);
    await this.db.transaction([
      {
        sql: "UPDATE fileEmbeddings SET audioEmbedding = NULL WHERE folder = ? AND fileName = ?",
        params: [folder, fileName],
      },
      {
        sql: `UPDATE files SET audioEmbeddingProcessedAt = ?, audioEmbeddingErrorAt = NULL WHERE folder = ? AND fileName = ?`,
        params: [Date.now(), folder, fileName],
      },
    ]);
    await this.vectorIndex.remove({ folder, fileName }, ["audio"]);
  }

  async getAudioEmbeddingProgress(): Promise<[total: number, done: number]> {
    const row = await this.db.get<{ total: number | null; done: number | null }>(
      `SELECT
         SUM(CASE WHEN exifProcessedAt IS NOT NULL AND (
           (mimeType LIKE 'video/%' AND audioCodec IS NOT NULL) OR mimeType LIKE 'audio/%'
         ) THEN 1 ELSE 0 END) AS total,
         SUM(CASE WHEN audioEmbeddingProcessedAt IS NOT NULL THEN 1 ELSE 0 END) AS done
       FROM files`,
    );
    return [row?.total ?? 0, row?.done ?? 0];
  }

  // --- search: see analysisSearch.ts
  audioSemanticSearch(...args: Parameters<AnalysisSearch["audioSemanticSearch"]>) {
    return this.search.audioSemanticSearch(...args);
  }

  audioTranscriptSearch(...args: Parameters<AnalysisSearch["audioTranscriptSearch"]>) {
    return this.search.audioTranscriptSearch(...args);
  }

  metadataSearch(...args: Parameters<AnalysisSearch["metadataSearch"]>) {
    return this.search.metadataSearch(...args);
  }

  semanticSearch(...args: Parameters<AnalysisSearch["semanticSearch"]>) {
    return this.search.semanticSearch(...args);
  }
}
