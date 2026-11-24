import type { AsyncSqlite } from "../common/asyncSqlite.ts";
import { attemptSync } from "../common/result.ts";
import { mimeTypeForFilename } from "../fileHandling/mimeTypes.ts";
import { getLogger } from "../observability/logger.ts";
import { deleteFacesStatements } from "../people/store/deleteFacesStatements.ts";
import type { FileRecord } from "./fileRecord.type.ts";
import {
  fileRecordToColumnNamesAndValues,
  rowToFileRecord,
} from "./rowFileRecordConversionFunctions.ts";
import { folderSubtreeSQL } from "./utils/folderSubtreeSQL.ts";
import { joinPath, normalizeFolderPath, splitPath } from "./utils/pathUtils.ts";
import type { VectorIndex } from "./vectorIndex/vectorIndex.ts";

const log = getLogger("IndexDatabase");

/**
 * Single-file and path-set writes on the `files` table: insert/update, user
 * edits and their writeback marker, move, remove, re-sync, and the
 * "generated" stamps. Every write that changes a counted column drops the
 * status-count cache; removals and moves also keep the vector index in step.
 */
export class FileStore {
  constructor(
    private readonly db: AsyncSqlite,
    private readonly vectorIndex: VectorIndex,
    private readonly invalidateStatusCounts: () => void,
    private readonly invalidateFaceClusterPCACache: () => void,
  ) {}

  private async runInsert(
    columns: { names: string[]; values: unknown[] },
    options: { mode: "insert" | "replace"; errorContext: string },
  ): Promise<void> {
    const { mode, errorContext } = options;
    if (columns.names.length !== columns.values.length) {
      throw new Error(
        `SQL parameter mismatch for ${errorContext}: ${columns.names.length} column names but ${columns.values.length} values. ` +
          `Columns: ${columns.names.join(", ")}. Values: ${JSON.stringify(columns.values)}`,
      );
    }

    const placeholders = columns.values.map(() => "?").join(", ");
    let sql: string;
    if (mode === "replace") {
      // Use ON CONFLICT DO UPDATE instead of INSERT OR REPLACE.
      // INSERT OR REPLACE is DELETE + INSERT, which fragments the B-tree badly
      // on repeated updates (observed: 14 GB for ~650 MB of actual data).
      // ON CONFLICT DO UPDATE is an in-place update — no rowid change, no dead pages.
      const updateCols = columns.names
        .filter((n) => n !== "folder" && n !== "fileName")
        .map((n) => `${n} = excluded.${n}`)
        .join(", ");
      const conflictAction = updateCols ? `DO UPDATE SET ${updateCols}` : `DO NOTHING`;
      sql = `INSERT INTO files (${columns.names.join(", ")}) VALUES (${placeholders}) ON CONFLICT(folder, fileName) ${conflictAction}`;
    } else {
      sql = `INSERT INTO files (${columns.names.join(", ")}) VALUES (${placeholders})`;
    }
    await this.db.run(sql, ...columns.values);
    this.invalidateStatusCounts();
  }

  async addFile(fileData: FileRecord): Promise<void> {
    const columns = fileRecordToColumnNamesAndValues(fileData);
    await this.runInsert(columns, {
      mode: "replace",
      errorContext: `${fileData.folder}${fileData.fileName}`,
    });
  }

  /** Moves a file record (and all related rows) to a new path. Returns false if the source is not in the database. */
  async moveFile(oldRelativePath: string, newRelativePath: string): Promise<boolean> {
    const { folder: oldFolder, fileName: oldFile } = splitPath(oldRelativePath);
    const { folder: newFolder, fileName: newFile } = splitPath(newRelativePath);

    const result = await this.db.run(
      "UPDATE files SET folder = ?, fileName = ? WHERE folder = ? AND fileName = ?",
      [newFolder, newFile, oldFolder, oldFile],
    );
    if (result.changes === 0) return false;

    await this.db.transaction([
      {
        sql: "UPDATE faces SET folder = ?, fileName = ? WHERE folder = ? AND fileName = ?",
        params: [newFolder, newFile, oldFolder, oldFile],
      },
      {
        sql: "UPDATE audioSegments SET folder = ?, fileName = ? WHERE folder = ? AND fileName = ?",
        params: [newFolder, newFile, oldFolder, oldFile],
      },
      {
        // fileEmbeddings is keyed by (folder, fileName), so a move has to carry
        // the row across or the file silently loses its CLIP vectors and drops
        // out of semantic search. faceEmbeddings is keyed by faceId and needs no
        // update — the `faces` rename above is enough.
        sql: "UPDATE fileEmbeddings SET folder = ?, fileName = ? WHERE folder = ? AND fileName = ?",
        params: [newFolder, newFile, oldFolder, oldFile],
      },
    ]);
    await this.vectorIndex.move(
      { folder: oldFolder, fileName: oldFile },
      { folder: newFolder, fileName: newFile },
    );
    return true;
  }

  async addOrUpdateFileData(
    relativePath: string,
    fileData: Partial<FileRecord> & { facesLastErrorAt?: string | null },
  ): Promise<void> {
    const { folder, fileName } = splitPath(relativePath);
    const execute = async () => {
      const row = await this.db.get<Record<string, string | number | null>>(
        "SELECT * FROM files WHERE folder = ? AND fileName = ?",
        folder,
        fileName,
      );
      // The raw row stores JSON columns (tags, personInImage, regions, aiTags) as
      // strings. They must be parsed back into values before merging, otherwise
      // fileRecordToColumnNamesAndValues re-stringifies the existing string and
      // double-encodes it — which, repeated across every face/embedding write,
      // grows these columns exponentially (escaped-quote blobs into the MBs).
      const existing: FileRecord = row
        ? rowToFileRecord(row)
        : { folder, fileName, mimeType: mimeTypeForFilename(relativePath) };
      const updatedEntry = {
        ...existing,
        ...fileData,
      };
      const columns = fileRecordToColumnNamesAndValues(updatedEntry);
      await this.runInsert(columns, {
        mode: "replace",
        errorContext: relativePath,
      });
    };

    await this.runWithRetry(execute);
  }

  /**
   * Stores a generated AI description (feedback #148). A single-column UPDATE,
   * like updateUserMetadata, so a slow generation landing late can never
   * clobber columns another writer changed meanwhile. Not a user edit, so it
   * leaves userMetadataDirtyAt alone.
   */
  async setAiDescription(relativePath: string, aiDescription: string): Promise<boolean> {
    const { folder, fileName } = splitPath(relativePath);
    const result = await this.runWithRetry(() =>
      this.db.run("UPDATE files SET aiDescription = ? WHERE folder = ? AND fileName = ?", [
        aiDescription,
        folder,
        fileName,
      ]),
    );
    return result.changes > 0;
  }

  /**
   * Updates only the user-editable tagging columns (`rating`, `tags`,
   * `description`) on an existing file row. Written as a targeted UPDATE of just
   * the provided columns — not through fileRecordToColumnNamesAndValues — so it
   * never touches (and therefore never clobbers) the EXIF/AI/face columns, and
   * doesn't depend on exifProcessedAt being set. Returns false if no matching
   * row exists.
   *
   * `description` is dual-purpose like `rating`/`tags`: EXIF processing seeds it
   * from the file's embedded caption (if any) on first scan, and an in-app edit
   * here simply overlays/replaces that value going forward (marked dirty for a
   * future writeback task, same as rating/tags). The file itself is never
   * touched — this is a DB-only edit.
   */
  async updateUserMetadata(
    relativePath: string,
    patch: {
      rating?: number | null;
      tags?: string[];
      editAdj?: string | null;
      description?: string | null;
    },
  ): Promise<boolean> {
    const { folder, fileName } = splitPath(relativePath);
    const sets: string[] = [];
    const params: (string | number | null)[] = [];

    if ("rating" in patch) {
      const r = patch.rating;
      // Ratings are 1–5; 0/null/negative all mean "unrated" and store as NULL so
      // the rating filter and MIN/MAX aggregates treat them consistently.
      const normalized =
        typeof r === "number" && Number.isFinite(r) && r > 0
          ? Math.min(5, Math.round(r))
          : null;
      sets.push("rating = ?");
      params.push(normalized);
    }

    if ("tags" in patch) {
      const tags = Array.isArray(patch.tags)
        ? [...new Set(patch.tags.map((t) => String(t).trim()).filter(Boolean))]
        : [];
      sets.push("tags = ?");
      params.push(tags.length > 0 ? JSON.stringify(tags) : null);
    }

    if ("editAdj" in patch) {
      sets.push("editAdj = ?");
      params.push(patch.editAdj ?? null);
    }

    if ("description" in patch) {
      const d = patch.description;
      const normalized = typeof d === "string" ? d.trim() : "";
      sets.push("description = ?");
      params.push(normalized.length > 0 ? normalized : null);
    }

    if (sets.length === 0) return false;

    // Mark the row as carrying in-app edits so a future writeback task can find
    // it. The files themselves stay read-only; this is purely a DB-side marker.
    sets.push("userMetadataDirtyAt = ?");
    params.push(Date.now());

    const result = await this.runWithRetry(() =>
      this.db.run(
        `UPDATE files SET ${sets.join(", ")} WHERE folder = ? AND fileName = ?`,
        [...params, folder, fileName],
      ),
    );
    return result.changes > 0;
  }

  /**
   * Lists rows carrying in-app rating/tag edits not yet written back to their
   * files (userMetadataDirtyAt IS NOT NULL). Intended for a future writeback
   * task; the files are never modified today.
   */
  async getFilesPendingMetadataWriteback(
    limit = 500,
  ): Promise<
    Array<{
      path: string;
      rating: number | null;
      tags: string[];
      description: string | null;
      dirtyAt: number;
    }>
  > {
    const rows = await this.db.all<{
      folder: string;
      fileName: string;
      rating: number | null;
      tags: string | null;
      description: string | null;
      userMetadataDirtyAt: number;
    }>(
      `SELECT folder, fileName, rating, tags, description, userMetadataDirtyAt
       FROM files
       WHERE userMetadataDirtyAt IS NOT NULL
       ORDER BY userMetadataDirtyAt ASC
       LIMIT ?`,
      limit,
    );
    return rows.map((row) => {
      const parsed = row.tags ? attemptSync((): unknown => JSON.parse(row.tags as string)) : null;
      if (parsed && !parsed.ok) {
        log.warn({ err: parsed.error, folder: row.folder, fileName: row.fileName }, "Unreadable tags; writing back none");
      }
      const tags =
        parsed?.ok && Array.isArray(parsed.value)
          ? parsed.value.filter((t): t is string => typeof t === "string")
          : [];
      return {
        path: `${row.folder}${row.fileName}`,
        rating: row.rating,
        tags,
        description: row.description,
        dirtyAt: row.userMetadataDirtyAt,
      };
    });
  }

  /** Clears the writeback marker after a file's metadata has been persisted. */
  async clearMetadataWriteback(relativePath: string): Promise<boolean> {
    const { folder, fileName } = splitPath(relativePath);
    const result = await this.runWithRetry(() =>
      this.db.run(
        "UPDATE files SET userMetadataDirtyAt = NULL WHERE folder = ? AND fileName = ?",
        [folder, fileName],
      ),
    );
    return result.changes > 0;
  }

  async getFileRecord(
    relativePath: string,
    _fields?: string[],
  ): Promise<FileRecord | undefined> {
    const { folder, fileName } = splitPath(relativePath);
    const row = await this.db.get<Record<string, string | number>>(
      "SELECT * FROM files WHERE folder = ? AND fileName = ?",
      folder,
      fileName,
    );
    if (!row) {
      return undefined;
    }

    return rowToFileRecord(row);
  }

  async addPaths(paths: string[]): Promise<void> {
    if (!paths.length) return;
    const pathStatements = paths.map((relativePath) => {
      const { folder, fileName } = splitPath(relativePath);
      const mimeType = mimeTypeForFilename(relativePath);
      return {
        sql: "INSERT OR IGNORE INTO files (folder, fileName, mimeType) VALUES (?, ?, ?)",
        params: [folder, fileName, mimeType] as unknown[],
      };
    });
    await this.db.transaction(pathStatements);
    this.invalidateStatusCounts();
  }

  /** Removes a file and returns success status. */
  async removeFile(relativePath: string): Promise<boolean> {
    const { folder, fileName } = splitPath(relativePath);
    const result = await this.db.run(
      "DELETE FROM files WHERE folder = ? AND fileName = ?",
      [folder, fileName],
    );
    await this.db.transaction(
      deleteFacesStatements("folder = ? AND fileName = ?", [folder, fileName]),
    );
    await this.db.run("DELETE FROM fileEmbeddings WHERE folder = ? AND fileName = ?", [
      folder,
      fileName,
    ]);
    await this.removeFromVectorIndex(folder, fileName);
    await this.db.run("DELETE FROM audioSegments WHERE folder = ? AND fileName = ?", [
      folder,
      fileName,
    ]);
    this.invalidateStatusCounts();
    return result.changes === 1;
  }

  /**
   * Marks an already-indexed file as needing a full re-sync after its content
   * changed on disk. Clears every "processed at" marker and derived artifact so
   * the background pipeline re-derives all metadata, embeddings, and faces from
   * scratch. Value columns (dateTaken, dimensions, etc.) are left in place so the
   * UI keeps showing the previous data until the reprocessing overwrites it.
   *
   * Returns whether a matching file row existed.
   */
  async markFileForResync(relativePath: string): Promise<boolean> {
    const { folder, fileName } = splitPath(relativePath);
    // The vectors themselves live in fileEmbeddings; dropping that row is the
    // equivalent of the old "imageEmbedding = NULL, audioEmbedding = NULL".
    await this.db.run(
      "DELETE FROM fileEmbeddings WHERE folder = ? AND fileName = ?",
      folder,
      fileName,
    );
    await this.removeFromVectorIndex(folder, fileName);
    const result = await this.db.run(
      `UPDATE files SET
         infoProcessedAt = NULL,
         exifProcessedAt = NULL,
         imageVariantsGeneratedAt = NULL,
         hlsGeneratedAt = NULL,
         facesProcessedAt = NULL,
         facesLastErrorAt = NULL,
         embeddingProcessedAt = NULL,
         embeddingErrorAt = NULL,
         analysisDecodeErrorAt = NULL,
         audioTranscript = NULL,
         audioTranscribedAt = NULL,
         audioTranscribeErrorAt = NULL,
         audioEmbeddingProcessedAt = NULL,
         audioEmbeddingErrorAt = NULL
       WHERE folder = ? AND fileName = ?`,
      [folder, fileName],
    );
    if (result.changes === 0) return false;

    // Face/audio detections are keyed by path and describe the old content, so
    // drop them; the analysis pass regenerates them from the new bytes.
    await this.db.transaction(
      deleteFacesStatements("folder = ? AND fileName = ?", [folder, fileName]),
    );
    await this.db.run("DELETE FROM audioSegments WHERE folder = ? AND fileName = ?", [
      folder,
      fileName,
    ]);
    this.invalidateFaceClusterPCACache();
    this.invalidateStatusCounts();
    return true;
  }

  async removePaths(paths: string[]): Promise<void> {
    if (!paths.length) return;

    const statements = paths.flatMap((relativePath) => {
      const { folder, fileName } = splitPath(relativePath);
      return [
        {
          sql: "DELETE FROM files WHERE folder = ? AND fileName = ?",
          params: [folder, fileName] as unknown[],
        },
        ...deleteFacesStatements("folder = ? AND fileName = ?", [folder, fileName]),
        {
          sql: "DELETE FROM fileEmbeddings WHERE folder = ? AND fileName = ?",
          params: [folder, fileName] as unknown[],
        },
        {
          sql: "DELETE FROM audioSegments WHERE folder = ? AND fileName = ?",
          params: [folder, fileName] as unknown[],
        },
      ];
    });

    await this.db.transaction(statements);
    for (const relativePath of paths) {
      const { folder, fileName } = splitPath(relativePath);
      await this.removeFromVectorIndex(folder, fileName);
    }
    this.invalidateStatusCounts();
  }

  private async removeFromVectorIndex(folder: string, fileName: string): Promise<void> {
    await this.vectorIndex.remove({ folder, fileName }, ["image", "audio", "videoFrames"]);
  }

  async removeFolder(relativePath: string): Promise<void> {
    const base = normalizeFolderPath(relativePath);
    const { where, params } = folderSubtreeSQL("folder", base);
    const statements = [
      { sql: `DELETE FROM files WHERE ${where}`, params },
      ...deleteFacesStatements(where, params),
      { sql: `DELETE FROM fileEmbeddings WHERE ${where}`, params },
      { sql: `DELETE FROM audioSegments WHERE ${where}`, params },
    ];
    await this.db.transaction(statements);
    await this.vectorIndex.removeFolder(base);
    this.invalidateStatusCounts();
  }

  /**
   * Returns the canonical relativePaths of every indexed file, optionally
   * scoped to a subfolder. Used to reconcile the index against the filesystem
   * so entries for moved/deleted files can be pruned.
   */
  async getIndexedPaths(subFolder?: string): Promise<string[]> {
    const { where, params } = folderSubtreeSQL("folder", subFolder ?? "/");
    const rows = await this.db.all<{ folder: string; fileName: string }>(
      `SELECT folder, fileName FROM files WHERE ${where}`,
      ...params,
    );
    return rows.map((row) => joinPath(row.folder, row.fileName));
  }

  /**
   * Marks that image variants have been generated for a file.
   */
  async markImageVariantsGenerated(relativePath: string): Promise<void> {
    const { folder, fileName } = splitPath(relativePath);
    await this.db.run(
      `UPDATE files
       SET imageVariantsGeneratedAt = datetime('now')
       WHERE folder = ? AND fileName = ?`,
      folder,
      fileName,
    );
  }

  /**
   * Marks that HLS has been generated for a file.
   */
  async markHLSGenerated(relativePath: string): Promise<void> {
    const { folder, fileName } = splitPath(relativePath);
    await this.db.run(
      `UPDATE files
       SET hlsGeneratedAt = datetime('now')
       WHERE folder = ? AND fileName = ?`,
      folder,
      fileName,
    );
  }

  private async runWithRetry<T>(fn: () => T | Promise<T>, attempts = 5): Promise<T> {
    let lastError: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        if (!message.toLowerCase().includes("busy")) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 10 * (i + 1)));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
