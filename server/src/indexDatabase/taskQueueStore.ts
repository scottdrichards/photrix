import type { AsyncSqlite } from "../common/asyncSqlite.ts";
import { mimeTypeForFilename } from "../fileHandling/mimeTypes.ts";
import { MetadataGroups } from "./fileRecord.type.ts";
import { SORT_DATE_EXPR } from "./fileQueryStore.ts";
import { joinPath } from "./utils/pathUtils.ts";

const filesNeedingMetadataUpdateFilter = (
  metadataGroupName: keyof typeof MetadataGroups,
) => {
  const base = `${metadataGroupName}ProcessedAt IS NULL OR ${metadataGroupName}ProcessedAt < modified`;
  // Face detection only applies to images. Other metadata groups still cover
  // both images and videos.
  if (metadataGroupName === "faces") {
    return `(${base}) AND mimeType LIKE 'image/%'`;
  }
  return base;
};

/**
 * What the background tasks poll for: files whose EXIF/info/face pass hasn't
 * run, the next image-variant or HLS job, and the thumbnail backfill list. It
 * stays in indexDatabase/ rather than taskOrchestrator/ or pipeline/: these are
 * plain SQL reads on `files`, taskOrchestrator may not import indexDatabase,
 * and the tasks that poll here (pipeline/, imageProcessing/, ...) already
 * depend on it, so the query sits one layer below its callers.
 */
export class TaskQueueStore {
  constructor(private readonly db: AsyncSqlite) {}

  async countFilesNeedingMetadataUpdate(
    metadataGroupName: keyof typeof MetadataGroups,
  ): Promise<number> {
    const row = await this.db.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM files WHERE ${filesNeedingMetadataUpdateFilter(metadataGroupName)}`,
    );
    return row?.count ?? 0;
  }

  async getFilesNeedingMetadataUpdate(
    metadataGroupName: keyof typeof MetadataGroups,
    limit = 200,
  ): Promise<
    Array<
      {
        relativePath: string;
        mimeType: string | null;
        sizeInBytes?: number;
      } & { [key in `${keyof typeof MetadataGroups}ProcessedAt`]?: string | null }
    >
  > {
    // Only the NULL-first branch is index-friendly. Cross-column comparison
    // (`exifProcessedAt < modified`) requires a full table scan that freezes the
    // synchronous read worker for many seconds on large libraries. Stale-mtime
    // detection is handled by the rescan path instead of this hot polling loop.
    const mimeFilter =
      metadataGroupName === "faces"
        ? " AND mimeType LIKE 'image/%' AND exifProcessedAt IS NOT NULL"
        : "";
    const orderBy =
      metadataGroupName === "faces"
        ? " ORDER BY facesLastErrorAt IS NOT NULL, facesLastErrorAt, folder, fileName"
        : "";
    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT folder, fileName, mimeType, sizeInBytes, ${metadataGroupName}ProcessedAt FROM files
       WHERE ${metadataGroupName}ProcessedAt IS NULL${mimeFilter}${orderBy}
       LIMIT ?`,
      limit,
    );

    return rows.map((row) => {
      const relativePath = joinPath(row.folder as string, row.fileName as string);
      const mimeType =
        (row.mimeType as string | null) ?? mimeTypeForFilename(relativePath) ?? null;
      const processedAt = row[metadataGroupName + "ProcessedAt"];

      return {
        relativePath,
        mimeType,
        sizeInBytes: typeof row.sizeInBytes === "number" ? row.sizeInBytes : undefined,
        [metadataGroupName + "ProcessedAt"]:
          typeof processedAt === "string" || processedAt === null
            ? processedAt
            : undefined,
      };
    });
  }

  async getImagesMissingDimensions(
    limit = 200,
  ): Promise<Array<{ relativePath: string }>> {
    const rows = await this.db.all<{ folder: string; fileName: string }>(
      `SELECT folder, fileName FROM files
       WHERE mimeType LIKE 'image/%'
         AND exifProcessedAt IS NOT NULL
         AND dimensionsWidth IS NULL
       LIMIT ?`,
      limit,
    );
    return rows.map((row) => ({
      relativePath: joinPath(row.folder, row.fileName),
    }));
  }

  /**
   * Every photo and video for the grid-thumbnail backfill
   * (imageProcessing/thumbnailBackfill.ts), in the grid's default order (newest
   * first, by the same sort date and index), so the tiles people scroll to
   * first are made first. Which ones still need work
   * is decided against the cache on disk, not a column here, so a dropped cache
   * entry is regenerated on the next pass.
   */
  async getThumbnailBackfillCandidates(): Promise<
    Array<{ relativePath: string; mimeType: string; sizeInBytes: number | null }>
  > {
    const rows = await this.db.all<{
      folder: string;
      fileName: string;
      mimeType: string;
      sizeInBytes: number | null;
    }>(
      `SELECT folder, fileName, mimeType, sizeInBytes
       FROM files
       WHERE mimeType LIKE 'image/%' OR mimeType LIKE 'video/%'
       ORDER BY ${SORT_DATE_EXPR} DESC, folder, fileName`,
    );
    return rows.map((row) => ({
      relativePath: joinPath(row.folder, row.fileName),
      mimeType: row.mimeType,
      sizeInBytes: row.sizeInBytes,
    }));
  }

  /**
   * Returns the next background task (image variants or HLS) that needs to be generated.
   * Prioritizes images, then videos. Returns null if nothing needs conversion.
   */
  async getNextBackgroundTask(): Promise<{
    type: "imageVariants" | "hls";
    relativePath: string;
    mimeType: string;
    duration?: number;
  } | null> {
    // Try to find an image that needs variants generated
    const imageTask = await this.db.get<{
      folder: string;
      fileName: string;
      mimeType: string;
    }>(
      `SELECT folder, fileName, mimeType
       FROM files
       WHERE mimeType LIKE 'image/%'
         AND imageVariantsGeneratedAt IS NULL
         AND infoProcessedAt IS NOT NULL
       LIMIT 1`,
    );

    if (imageTask) {
      return {
        type: "imageVariants",
        relativePath: joinPath(imageTask.folder, imageTask.fileName),
        mimeType: imageTask.mimeType,
      };
    }

    // Try to find a video that needs HLS generated
    const hlsTask = await this.db.get<{
      folder: string;
      fileName: string;
      mimeType: string;
      duration: number | null;
    }>(
      `SELECT folder, fileName, mimeType, duration
       FROM files
       WHERE mimeType LIKE 'video/%'
         AND hlsGeneratedAt IS NULL
         AND exifProcessedAt IS NOT NULL
       LIMIT 1`,
    );

    if (hlsTask) {
      return {
        type: "hls",
        relativePath: joinPath(hlsTask.folder, hlsTask.fileName),
        mimeType: hlsTask.mimeType,
        duration: hlsTask.duration ?? undefined,
      };
    }

    return null;
  }
}
