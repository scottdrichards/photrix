import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { CACHE_DIR } from "../common/cacheUtils.ts";
import { AsyncSqlite } from "../common/asyncSqlite.ts";
import { mimeTypeForFilename } from "../fileHandling/mimeTypes.ts";
import { MetadataGroups, type FileRecord } from "./fileRecord.type.ts";
import { filterToSQL } from "./filterToSQL.ts";
import {
  type DateHistogramResult,
  type FaceClusterDetailResult,
  type FaceClusterFace,
  type FaceClusterResult,
  type FilterElement,
  type GeoClusterResult,
  type QueryOptions,
  type QueryResult,
} from "./indexDatabase.type.ts";
import {
  fileRecordToColumnNamesAndValues,
  rowToFileRecord,
} from "./rowFileRecordConversionFunctions.ts";
import { joinPath, normalizeFolderPath, splitPath } from "./utils/pathUtils.ts";
import { escapeLikeLiteral } from "./utils/sqlUtils.ts";
import { prepareTables } from "./prepareTables.ts";

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

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

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

const DEFAULT_FACE_CLUSTER_SIMILARITY = 0.62;

const alignEmbeddingBuffer = (buffer: Buffer) => {
  const aligned = new Uint8Array(buffer.byteLength);
  aligned.set(buffer);
  return new Float64Array(aligned.buffer);
};

const toUnitVector = (vector: Float64Array): Float64Array | null => {
  let magnitudeSquared = 0;
  for (let i = 0; i < vector.length; i += 1) {
    const value = vector[i] ?? 0;
    magnitudeSquared += value * value;
  }

  if (magnitudeSquared <= 0) {
    return null;
  }

  const magnitude = Math.sqrt(magnitudeSquared);
  const normalized = new Float64Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) {
    normalized[i] = (vector[i] ?? 0) / magnitude;
  }
  return normalized;
};

const cosineSimilarity = (left: Float64Array, right: Float64Array) => {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  for (let i = 0; i < length; i += 1) {
    dot += (left[i] ?? 0) * (right[i] ?? 0);
  }
  return dot;
};

export class IndexDatabase {
  public readonly storagePath: string;
  private db!: AsyncSqlite;
  private dbFilePath!: string;

  constructor(storagePath: string) {
    this.storagePath = storagePath;
  }

  /** Can't be part of constructor because it's async */
  async init(): Promise<void> {
    const envDbLocation = process.env.INDEX_DB_LOCATION?.trim();
    const databaseDirectory = envDbLocation || CACHE_DIR;
    this.dbFilePath = path.join(path.resolve(databaseDirectory), "index.db");

    const directoryPath = path.dirname(this.dbFilePath);
    const rootPath = path.parse(directoryPath).root;
    if (directoryPath !== rootPath) {
      await mkdir(directoryPath, { recursive: true });
    }

    this.db = await AsyncSqlite.open(this.dbFilePath, {
      pragmas: [
        "journal_mode = WAL",
        "synchronous = NORMAL",
        "wal_autocheckpoint = 1000",
      ],
      customFunctions: [
        { name: "REGEXP", options: { deterministic: true }, type: "regexp" },
        {
          name: "cosine_similarity",
          options: { deterministic: true },
          type: "cosine_similarity",
        },
      ],
    });

    await prepareTables(this.db);

    await this.db.get<{ count: number }>("SELECT COUNT(*) as count FROM files");
  }

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
    const verb = mode === "replace" ? "INSERT OR REPLACE" : "INSERT";
    const sql = `${verb} INTO files (${columns.names.join(", ")}) VALUES (${placeholders})`;
    await this.db.run(sql, ...columns.values);
  }

  private async countEntries(whereClause?: string): Promise<number> {
    const sql = whereClause
      ? `SELECT COUNT(*) as count FROM files WHERE ${whereClause}`
      : "SELECT COUNT(*) as count FROM files";
    const row = await this.db.get<{ count: number }>(sql);
    return row?.count ?? 0;
  }

  async addFile(fileData: FileRecord): Promise<void> {
    const columns = fileRecordToColumnNamesAndValues(fileData);
    await this.runInsert(columns, {
      mode: "replace",
      errorContext: `${fileData.folder}${fileData.fileName}`,
    });
  }

  async moveFile(oldRelativePath: string, newRelativePath: string): Promise<void> {
    const { folder: oldFolder, fileName: oldFile } = splitPath(oldRelativePath);
    const row = await this.db.get<FileRecord>(
      "SELECT * FROM files WHERE folder = ? AND fileName = ?",
      oldFolder,
      oldFile,
    );
    if (!row) {
      throw new Error(
        `moveFile: File at path "${oldRelativePath}" does not exist in the database.`,
      );
    }

    const { folder: newFolder, fileName: newFile } = splitPath(newRelativePath);
    const updated: FileRecord = {
      ...row,
      folder: newFolder,
      fileName: newFile,
    };

    const columns = fileRecordToColumnNamesAndValues(updated);
    const placeholders = columns.values.map(() => "?").join(", ");
    await this.db.transaction([
      {
        sql: "DELETE FROM files WHERE folder = ? AND fileName = ?",
        params: [oldFolder, oldFile],
      },
      {
        sql: `INSERT INTO files (${columns.names.join(", ")}) VALUES (${placeholders})`,
        params: columns.values,
      },
      {
        sql: "UPDATE faces SET folder = ?, fileName = ? WHERE folder = ? AND fileName = ?",
        params: [newFolder, newFile, oldFolder, oldFile],
      },
    ]);
  }

  async addOrUpdateFileData(
    relativePath: string,
    fileData: Partial<FileRecord> & { facesLastErrorAt?: string | null },
  ): Promise<void> {
    const { folder, fileName } = splitPath(relativePath);
    const execute = async () => {
      const row = await this.db.get<FileRecord>(
        "SELECT * FROM files WHERE folder = ? AND fileName = ?",
        folder,
        fileName,
      );
      const updatedEntry = {
        ...(row ?? {
          folder,
          fileName,
          mimeType: mimeTypeForFilename(relativePath),
        }),
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

  async countMissingInfo(): Promise<number> {
    return this.countEntries(
      "sizeInBytes IS NULL OR created IS NULL OR modified IS NULL",
    );
  }

  async countMissingDateTaken(): Promise<number> {
    return this.countEntries(
      "(mimeType LIKE 'image/%' OR mimeType LIKE 'video/%') AND dateTaken IS NULL AND exifProcessedAt IS NULL",
    );
  }

  async countMediaEntries(): Promise<number> {
    return this.countEntries("mimeType LIKE 'image/%' OR mimeType LIKE 'video/%'");
  }

  async countImageEntries(): Promise<number> {
    return this.countEntries("mimeType LIKE 'image/%'");
  }

  async countAllEntries(): Promise<number> {
    return this.countEntries();
  }

  async getStatusCounts(): Promise<{
    allEntries: number;
    imageEntries: number;
    videoEntries: number;
    missingFileMetadata: number;
    missingMediaMetadata: number;
    missingThumbnails: number;
    missingFaceDetection: number;
  }> {
    const row = await this.db.get<{
      allEntries: number | null;
      imageEntries: number | null;
      videoEntries: number | null;
      missingFileMetadata: number | null;
      missingMediaMetadata: number | null;
      missingThumbnails: number | null;
      missingFaceDetection: number | null;
    }>(
      `SELECT
         COUNT(*) AS allEntries,
         SUM(CASE WHEN mimeType LIKE 'image/%' THEN 1 ELSE 0 END) AS imageEntries,
         SUM(CASE WHEN mimeType LIKE 'video/%' THEN 1 ELSE 0 END) AS videoEntries,
         SUM(CASE WHEN sizeInBytes IS NULL OR created IS NULL OR modified IS NULL THEN 1 ELSE 0 END) AS missingFileMetadata,
         SUM(CASE WHEN (mimeType LIKE 'image/%' OR mimeType LIKE 'video/%') AND exifProcessedAt IS NULL THEN 1 ELSE 0 END) AS missingMediaMetadata,
         SUM(CASE WHEN mimeType LIKE 'image/%' AND imageVariantsGeneratedAt IS NULL THEN 1 ELSE 0 END) AS missingThumbnails,
         SUM(CASE WHEN mimeType LIKE 'image/%' AND facesProcessedAt IS NULL THEN 1 ELSE 0 END) AS missingFaceDetection
       FROM files`,
    );

    return {
      allEntries: row?.allEntries ?? 0,
      imageEntries: row?.imageEntries ?? 0,
      videoEntries: row?.videoEntries ?? 0,
      missingFileMetadata: row?.missingFileMetadata ?? 0,
      missingMediaMetadata: row?.missingMediaMetadata ?? 0,
      missingThumbnails: row?.missingThumbnails ?? 0,
      missingFaceDetection: row?.missingFaceDetection ?? 0,
    };
  }

  async getMostRecentExifProcessedEntry(): Promise<{
    folder: string;
    fileName: string;
    completedAt: string;
  } | null> {
    const row = await this.db.get<{
      folder: string;
      fileName: string;
      exifProcessedAt: number | null;
    }>(
      `SELECT folder, fileName, exifProcessedAt
       FROM files
       WHERE exifProcessedAt IS NOT NULL
       ORDER BY exifProcessedAt DESC
       LIMIT 1`,
    );

    if (!row) {
      return null;
    }

    return {
      folder: row.folder,
      fileName: row.fileName,
      completedAt: new Date(row.exifProcessedAt as unknown as number).toISOString(),
    };
  }

  async getRatingStats(): Promise<{
    total: number;
    rated: number;
    unrated: number;
    distribution: Record<string, number>;
  }> {
    const rows = await this.db.all<{ rating: number | null; count: number }>(
      `SELECT rating, COUNT(*) as count
       FROM files
       WHERE mimeType LIKE 'image/%' OR mimeType LIKE 'video/%'
       GROUP BY rating`,
    );

    const distribution: Record<string, number> = {};
    let rated = 0;
    let total = 0;

    for (const row of rows) {
      const key = row.rating === null ? "null" : String(row.rating);
      distribution[key] = row.count;
      total += row.count;
      if (row.rating !== null) {
        rated += row.count;
      }
    }

    return {
      total,
      rated,
      unrated: total - rated,
      distribution,
    };
  }

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
    }>,
    detectedAt: Date = new Date(),
  ): Promise<void> {
    const { folder, fileName } = splitPath(relativePath);
    const detectedAtMs = detectedAt.getTime();

    const statements: Array<{ sql: string; params: unknown[] }> = [
      {
        sql: "DELETE FROM faces WHERE folder = ? AND fileName = ?",
        params: [folder, fileName],
      },
    ];

    for (const face of faces) {
      const embeddingBuffer = Buffer.from(
        face.embedding.buffer,
        face.embedding.byteOffset,
        face.embedding.byteLength,
      );
      const centeredBox = toCenterBoxFromTopLeft(face.box);
      statements.push({
        sql: `INSERT INTO faces
                (folder, fileName, boxX, boxY, boxWidth, boxHeight, confidence, embedding, detectedAt)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          folder,
          fileName,
          centeredBox.x,
          centeredBox.y,
          centeredBox.width,
          centeredBox.height,
          face.confidence,
          embeddingBuffer,
          detectedAtMs,
        ],
      });
    }

    statements.push({
      sql: "UPDATE files SET facesProcessedAt = ?, facesLastErrorAt = NULL WHERE folder = ? AND fileName = ?",
      params: [detectedAtMs, folder, fileName],
    });

    await this.db.transaction(statements);
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
    const statements: Array<{ sql: string; params: unknown[] }> = [
      {
        sql: "DELETE FROM faces WHERE folder = ? AND fileName = ?",
        params: [folder, fileName],
      },
      ...faces.map((face) => ({
        sql: `INSERT INTO faces
                (folder, fileName, boxX, boxY, boxWidth, boxHeight, confidence, embedding, personId, detectedAt)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          folder,
          fileName,
          face.box.x,
          face.box.y,
          face.box.width,
          face.box.height,
          1,
          Buffer.alloc(0),
          face.personId,
          detectedAtMs,
        ],
      })),
      {
        sql: "UPDATE files SET facesProcessedAt = ? WHERE folder = ? AND fileName = ?",
        params: [detectedAtMs, folder, fileName],
      },
    ];

    await this.db.transaction(statements);
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
      `SELECT id, boxX, boxY, boxWidth, boxHeight, confidence, embedding, personId, detectedAt
       FROM faces
       WHERE folder = ? AND fileName = ?
       ORDER BY id`,
      folder,
      fileName,
    );

    return rows.map((row) => {
      // Defensive copy: SQLite BLOB buffers may not be 8-byte aligned which
      // would cause `new Float64Array(buffer, offset, length)` to throw.
      // Copying into a fresh Uint8Array gives us an aligned ArrayBuffer.
      const aligned = new Uint8Array(row.embedding.byteLength);
      aligned.set(row.embedding);
      return {
        id: row.id,
        box: {
          x: row.boxX,
          y: row.boxY,
          width: row.boxWidth,
          height: row.boxHeight,
        },
        confidence: row.confidence,
        embedding: new Float64Array(aligned.buffer),
        personId: row.personId,
        detectedAt: row.detectedAt,
      };
    });
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
  }

  /** Removes a file and returns success status. */
  async removeFile(relativePath: string): Promise<boolean> {
    const { folder, fileName } = splitPath(relativePath);
    const result = await this.db.run(
      "DELETE FROM files WHERE folder = ? AND fileName = ?",
      [folder, fileName],
    );
    await this.db.run("DELETE FROM faces WHERE folder = ? AND fileName = ?", [
      folder,
      fileName,
    ]);
    return result.changes === 1;
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
        {
          sql: "DELETE FROM faces WHERE folder = ? AND fileName = ?",
          params: [folder, fileName] as unknown[],
        },
      ];
    });

    await this.db.transaction(statements);
  }

  async removeFolder(relativePath: string): Promise<void> {
    const base = normalizeFolderPath(relativePath);
    const likePattern = `${escapeLikeLiteral(base)}%`;
    const statements = [
      {
        sql: "DELETE FROM files WHERE folder LIKE ? ESCAPE '\\'",
        params: [likePattern],
      },
      {
        sql: "DELETE FROM faces WHERE folder LIKE ? ESCAPE '\\'",
        params: [likePattern],
      },
    ];
    await this.db.transaction(statements);
  }

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

  async allFiles(): Promise<FileRecord[]> {
    const rows =
      await this.db.all<Record<string, string | number>>("SELECT * FROM files");
    return rows.map((row) => rowToFileRecord(row));
  }

  async getFolders(relativePath: string): Promise<Array<string>> {
    const base = normalizeFolderPath(relativePath);

    if (base === "/") {
      const rows = await this.db.all<{ folderName: string | null }>(
        `SELECT DISTINCT 
         CASE 
         WHEN instr(substr(folder, 2), '/') > 0 
         THEN substr(folder, 2, instr(substr(folder, 2), '/') - 1)
         ELSE substr(folder, 2)
         END AS folderName
       FROM files
       WHERE folder LIKE '/%' AND length(folder) > 1
       ORDER BY folderName`,
      );
      return rows
        .map((row) => row.folderName)
        .filter((v): v is string => Boolean(v))
        .sort((a, b) => a.localeCompare(b));
    }

    const escapedPrefix = escapeLikeLiteral(base);
    const prefixLen = base.length;
    const rows = await this.db.all<{ folderName: string | null }>(
      `SELECT DISTINCT 
         substr(folder, ?, instr(substr(folder, ?), '/') - 1) AS folderName
       FROM files
       WHERE folder LIKE ? ESCAPE '\\'
         AND length(folder) > ?
         AND instr(substr(folder, ?), '/') > 0
       ORDER BY folderName`,
      prefixLen + 1,
      prefixLen + 1,
      `${escapedPrefix}%`,
      prefixLen,
      prefixLen + 1,
    );
    return rows
      .map((row) => row.folderName)
      .filter((v): v is string => Boolean(v))
      .sort((a, b) => a.localeCompare(b));
  }

  async queryFieldSuggestions(options: {
    field:
      | "personInImage"
      | "tags"
      | "aiTags"
      | "cameraMake"
      | "cameraModel"
      | "lens"
      | "rating";
    search: string;
    filter: FilterElement;
    limit?: number;
  }): Promise<string[]> {
    const { field, search, filter } = options;
    const limit = Math.max(1, Math.min(100, options.limit ?? 8));
    const normalizedSearch = search.trim();

    const { where: whereClause, params: whereParams } = filterToSQL(filter);
    const likeQuery =
      normalizedSearch.length === 0 ? "%" : `%${escapeLikeLiteral(normalizedSearch)}%`;
    const whereFragment = whereClause ? `AND (${whereClause})` : "";

    if (field === "personInImage" || field === "tags" || field === "aiTags") {
      const rows = await this.db.all<{ suggestion: string }>(
        `SELECT DISTINCT json_each.value AS suggestion
         FROM files, json_each(${field})
         WHERE files.${field} IS NOT NULL
           AND json_each.value IS NOT NULL
           AND json_each.value != ''
           AND json_each.value LIKE ? ESCAPE '\\'
           ${whereFragment}
         ORDER BY suggestion COLLATE NOCASE ASC
         LIMIT ?`,
        likeQuery,
        ...whereParams,
        limit,
      );

      return rows
        .map((row) => row.suggestion)
        .filter((value) => typeof value === "string" && value.length > 0);
    }

    if (field === "rating") {
      const rows = await this.db.all<{ suggestion: string }>(
        `SELECT DISTINCT CAST(rating AS TEXT) AS suggestion
         FROM files
         WHERE rating IS NOT NULL
           AND CAST(rating AS TEXT) LIKE ? ESCAPE '\\'
           ${whereFragment}
         ORDER BY CAST(suggestion AS INTEGER) DESC
         LIMIT ?`,
        likeQuery,
        ...whereParams,
        limit,
      );

      return rows
        .map((row) => row.suggestion)
        .filter((value) => typeof value === "string" && value.length > 0);
    }

    const rows = await this.db.all<{ suggestion: string }>(
      `SELECT DISTINCT ${field} AS suggestion
       FROM files
       WHERE ${field} IS NOT NULL
         AND ${field} != ''
         AND ${field} LIKE ? ESCAPE '\\'
         ${whereFragment}
       ORDER BY suggestion COLLATE NOCASE ASC
       LIMIT ?`,
      likeQuery,
      ...whereParams,
      limit,
    );

    return rows
      .map((row) => row.suggestion)
      .filter((value) => typeof value === "string" && value.length > 0);
  }

  async queryFieldSuggestionsWithCounts(options: {
    field:
      | "personInImage"
      | "tags"
      | "aiTags"
      | "cameraMake"
      | "cameraModel"
      | "lens"
      | "rating";
    search: string;
    filter: FilterElement;
    limit?: number;
  }): Promise<Array<{ value: string; count: number }>> {
    const { field, search, filter } = options;
    const limit = Math.max(1, Math.min(100, options.limit ?? 8));
    const normalizedSearch = search.trim();

    const { where: whereClause, params: whereParams } = filterToSQL(filter);
    const likeQuery =
      normalizedSearch.length === 0 ? "%" : `%${escapeLikeLiteral(normalizedSearch)}%`;
    const whereFragment = whereClause ? `AND (${whereClause})` : "";

    if (field === "personInImage" || field === "tags" || field === "aiTags") {
      const rows = await this.db.all<{
        suggestion: string;
        count: number;
      }>(
        `SELECT
             json_each.value AS suggestion,
             COUNT(DISTINCT files.folder || files.fileName) AS count
           FROM files, json_each(${field})
           WHERE files.${field} IS NOT NULL
             AND json_each.value IS NOT NULL
             AND json_each.value != ''
             AND json_each.value LIKE ? ESCAPE '\\'
             ${whereFragment}
           GROUP BY json_each.value
           ORDER BY count DESC, suggestion COLLATE NOCASE ASC
           LIMIT ?`,
        likeQuery,
        ...whereParams,
        limit,
      );

      return rows
        .filter(
          (row) =>
            typeof row.suggestion === "string" &&
            row.suggestion.length > 0 &&
            Number.isFinite(row.count),
        )
        .map((row) => ({ value: row.suggestion, count: row.count }));
    }

    if (field === "rating") {
      const rows = await this.db.all<{ suggestion: string; count: number }>(
        `SELECT
             CAST(rating AS TEXT) AS suggestion,
             COUNT(*) AS count
           FROM files
           WHERE rating IS NOT NULL
             AND CAST(rating AS TEXT) LIKE ? ESCAPE '\\'
             ${whereFragment}
           GROUP BY rating
           ORDER BY CAST(suggestion AS INTEGER) DESC
           LIMIT ?`,
        likeQuery,
        ...whereParams,
        limit,
      );

      return rows
        .filter(
          (row) =>
            typeof row.suggestion === "string" &&
            row.suggestion.length > 0 &&
            Number.isFinite(row.count),
        )
        .map((row) => ({ value: row.suggestion, count: row.count }));
    }

    const rows = await this.db.all<{ suggestion: string; count: number }>(
      `SELECT
           ${field} AS suggestion,
           COUNT(*) AS count
         FROM files
         WHERE ${field} IS NOT NULL
           AND ${field} != ''
           AND ${field} LIKE ? ESCAPE '\\'
           ${whereFragment}
         GROUP BY ${field}
         ORDER BY count DESC, suggestion COLLATE NOCASE ASC
         LIMIT ?`,
      likeQuery,
      ...whereParams,
      limit,
    );

    return rows
      .filter(
        (row) =>
          typeof row.suggestion === "string" &&
          row.suggestion.length > 0 &&
          Number.isFinite(row.count),
      )
      .map((row) => ({ value: row.suggestion, count: row.count }));
  }

  async queryGeoClusters(options: {
    filter: QueryOptions["filter"];
    clusterSize: number;
    bounds?: { west: number; east: number; north: number; south: number } | null;
  }): Promise<GeoClusterResult> {
    const { filter, clusterSize, bounds } = options;
    const { where: whereClause, params: whereParams } = filterToSQL(filter);
    const bucket = Math.max(clusterSize, 0.00000001);
    const latOrigin = Math.floor((bounds?.south ?? 0) / bucket) * bucket;
    const lonOrigin = Math.floor((bounds?.west ?? 0) / bucket) * bucket;

    const rows = await this.db.all<{
      latitude: number;
      longitude: number;
      count: number;
      samplePath: string | null;
      sampleName: string | null;
    }>(
      `WITH buckets AS (
         SELECT
           CAST(FLOOR((locationLatitude - ?) / ?) AS INTEGER) AS latBucket,
           CAST(FLOOR((locationLongitude - ?) / ?) AS INTEGER) AS lonBucket,
           locationLatitude,
           locationLongitude,
           folder,
           fileName
         FROM files
         WHERE locationLatitude IS NOT NULL
           AND locationLongitude IS NOT NULL
           ${whereClause ? `AND ${whereClause}` : ""}
       ),
       agg AS (
         SELECT
           latBucket,
           lonBucket,
           COUNT(*) AS count
         FROM buckets
         GROUP BY latBucket, lonBucket
       ),
       ranked AS (
         SELECT
           b.latBucket,
           b.lonBucket,
           b.locationLatitude,
           b.locationLongitude,
           b.folder,
           b.fileName,
           ROW_NUMBER() OVER (PARTITION BY b.latBucket, b.lonBucket ORDER BY b.folder, b.fileName) AS rn
         FROM buckets b
       )
       SELECT
         (a.latBucket + 0.5) * ? + ? AS latitude,
         (a.lonBucket + 0.5) * ? + ? AS longitude,
         a.count AS count,
         MIN(CASE WHEN r.rn = 1 THEN r.folder || r.fileName END) AS samplePath,
         MIN(CASE WHEN r.rn = 1 THEN r.fileName END) AS sampleName
       FROM agg a
       JOIN ranked r ON r.latBucket = a.latBucket AND r.lonBucket = a.lonBucket
       GROUP BY a.latBucket, a.lonBucket
       ORDER BY count DESC`,
      latOrigin,
      bucket,
      lonOrigin,
      bucket,
      ...whereParams,
      bucket,
      latOrigin,
      bucket,
      lonOrigin,
    );

    const total = rows.reduce((sum, row) => sum + (row.count ?? 0), 0);

    return {
      clusters: rows,
      total,
    };
  }

  async queryFaceClusters(options: {
    filter: QueryOptions["filter"];
    similarityThreshold?: number;
  }): Promise<FaceClusterResult> {
    const { filter, similarityThreshold = DEFAULT_FACE_CLUSTER_SIMILARITY } = options;

    const clusterData = await this.computeFaceClusters(filter, similarityThreshold);

    // Return only summaries (without faces array) for performance
    const clusters = clusterData.sortedClusters.map((cluster) => ({
      id: cluster.id,
      count: cluster.count,
      representative: cluster.representative,
    }));

    const totalFaces = clusterData.sortedClusters.reduce(
      (sum, cluster) => sum + cluster.count,
      0,
    );

    return {
      clusters,
      totalFaces,
      totalClusters: clusters.length,
    };
  }

  async getFaceClusterDetail(options: {
    filter: QueryOptions["filter"];
    clusterId: string;
    similarityThreshold?: number;
  }): Promise<FaceClusterDetailResult> {
    const {
      filter,
      clusterId,
      similarityThreshold = DEFAULT_FACE_CLUSTER_SIMILARITY,
    } = options;

    const clusterData = await this.computeFaceClusters(filter, similarityThreshold);
    const cluster = clusterData.sortedClusters.find((c) => c.id === clusterId);

    if (!cluster) {
      return { cluster: null };
    }

    return {
      cluster: {
        id: cluster.id,
        count: cluster.count,
        representative: cluster.representative,
        faces: cluster.faces,
      },
    };
  }

  private async computeFaceClusters(
    filter: QueryOptions["filter"],
    similarityThreshold: number,
  ): Promise<{
    sortedClusters: Array<{
      id: string;
      count: number;
      representative: FaceClusterFace;
      faces: FaceClusterFace[];
    }>;
  }> {
    const { where: whereClause, params: whereParams } = filterToSQL(filter);
    const normalizedThreshold = Math.min(Math.max(similarityThreshold, -1), 1);

    const rows = await this.db.all<{
      folder: string;
      fileName: string;
      boxX: number;
      boxY: number;
      boxWidth: number;
      boxHeight: number;
      embedding: Buffer;
      mimeType: string | null;
      dimensionWidth: number | null;
      dimensionHeight: number | null;
      regions: string | null;
    }>(
      `WITH filtered_files AS (
         SELECT folder, fileName
         FROM files
         ${whereClause ? `WHERE ${whereClause}` : ""}
       )
       SELECT
         faces.folder,
         faces.fileName,
         faces.boxX,
         faces.boxY,
         faces.boxWidth,
         faces.boxHeight,
         faces.embedding,
         files.mimeType,
         files.dimensionsWidth AS dimensionWidth,
         files.dimensionsHeight AS dimensionHeight,
         files.regions
       FROM faces
       JOIN filtered_files
         ON filtered_files.folder = faces.folder
        AND filtered_files.fileName = faces.fileName
       JOIN files
         ON files.folder = faces.folder
        AND files.fileName = faces.fileName
       WHERE LENGTH(faces.embedding) > 0
       ORDER BY faces.folder, faces.fileName, faces.id`,
      ...whereParams,
    );

    type FaceRow = {
      path: string;
      fileName: string;
      box: { x: number; y: number; width: number; height: number };
      mimeType: string | null;
      dimensionWidth: number | null;
      dimensionHeight: number | null;
      regions: string | null;
      vector: Float64Array;
    };

    type MutableCluster = {
      faces: FaceRow[];
      centroid: Float64Array;
    };

    const clusters: MutableCluster[] = [];

    for (const row of rows) {
      const alignedEmbedding = alignEmbeddingBuffer(row.embedding);
      const unitVector = toUnitVector(alignedEmbedding);
      if (!unitVector) {
        continue;
      }

      const nextFace: FaceRow = {
        path: joinPath(row.folder, row.fileName),
        fileName: row.fileName,
        box: {
          x: row.boxX,
          y: row.boxY,
          width: row.boxWidth,
          height: row.boxHeight,
        },
        mimeType: row.mimeType,
        dimensionWidth: row.dimensionWidth,
        dimensionHeight: row.dimensionHeight,
        regions: row.regions,
        vector: unitVector,
      };

      let bestClusterIndex = -1;
      let bestSimilarity = -2;

      for (let i = 0; i < clusters.length; i += 1) {
        const similarity = cosineSimilarity(unitVector, clusters[i].centroid);
        if (similarity > bestSimilarity) {
          bestSimilarity = similarity;
          bestClusterIndex = i;
        }
      }

      if (bestClusterIndex < 0 || bestSimilarity < normalizedThreshold) {
        clusters.push({ faces: [nextFace], centroid: unitVector });
        continue;
      }

      const cluster = clusters[bestClusterIndex];
      const previousCount = cluster.faces.length;
      cluster.faces.push(nextFace);

      const updatedCentroid = new Float64Array(cluster.centroid.length);
      for (let i = 0; i < cluster.centroid.length; i += 1) {
        updatedCentroid[i] =
          ((cluster.centroid[i] ?? 0) * previousCount + (unitVector[i] ?? 0)) /
          (previousCount + 1);
      }

      cluster.centroid = toUnitVector(updatedCentroid) ?? updatedCentroid;
    }

    const sortedClusters = clusters
      .map((cluster, index) => {
        const withScores = cluster.faces.map((face) => ({
          face,
          similarity: cosineSimilarity(face.vector, cluster.centroid),
        }));
        withScores.sort((left, right) => right.similarity - left.similarity);

        const representativeFace = withScores[0]?.face;
        if (!representativeFace) {
          return null;
        }

        return {
          id: `person-${index + 1}`,
          count: cluster.faces.length,
          representative: {
            path: representativeFace.path,
            fileName: representativeFace.fileName,
            box: representativeFace.box,
            mimeType: representativeFace.mimeType,
            dimensionWidth: representativeFace.dimensionWidth,
            dimensionHeight: representativeFace.dimensionHeight,
            regions: representativeFace.regions,
          },
          faces: withScores.map(({ face }) => ({
            path: face.path,
            fileName: face.fileName,
            box: face.box,
            mimeType: face.mimeType,
            dimensionWidth: face.dimensionWidth,
            dimensionHeight: face.dimensionHeight,
            regions: face.regions,
          })),
        };
      })
      .filter((cluster): cluster is NonNullable<typeof cluster> => Boolean(cluster))
      .sort((left, right) => right.count - left.count || left.id.localeCompare(right.id));

    return { sortedClusters };
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
    const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    await this.db.run(
      `UPDATE files
       SET imageEmbedding = ?, embeddingProcessedAt = ?, embeddingErrorAt = NULL
       WHERE folder = ? AND fileName = ?`,
      buffer,
      Date.now(),
      folder,
      fileName,
    );
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

  async getEmbeddingProgress(): Promise<[total: number, done: number]> {
    const row = await this.db.get<{ total: number | null; done: number | null }>(
      `SELECT
         SUM(CASE WHEN mimeType LIKE 'image/%' AND infoProcessedAt IS NOT NULL THEN 1 ELSE 0 END) AS total,
         SUM(CASE WHEN mimeType LIKE 'image/%' AND embeddingProcessedAt IS NOT NULL THEN 1 ELSE 0 END) AS done
       FROM files`,
    );
    return [row?.total ?? 0, row?.done ?? 0];
  }

  async semanticSearch(
    queryVector: Float32Array,
    filter: FilterElement,
    limit: number,
  ): Promise<Array<FileRecord & { similarity: number }>> {
    const { where: whereClause, params: whereParams } = filterToSQL(filter);

    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT *
       FROM files
       WHERE imageEmbedding IS NOT NULL
         AND (mimeType LIKE 'image/%')
         ${whereClause ? `AND (${whereClause})` : ""}`,
      ...whereParams,
    );

    type ScoredRow = { record: FileRecord; similarity: number };
    const scored: ScoredRow[] = [];

    for (const row of rows) {
      const rawBuf = row.imageEmbedding as Buffer | null;
      if (!rawBuf) continue;

      const aligned = new Uint8Array(rawBuf.byteLength);
      aligned.set(rawBuf);
      const embedding = new Float32Array(aligned.buffer);

      // CLIP embeddings are L2-normalised so cosine similarity == dot product
      let dot = 0;
      const len = Math.min(queryVector.length, embedding.length);
      for (let i = 0; i < len; i++) {
        dot += (queryVector[i] ?? 0) * (embedding[i] ?? 0);
      }

      const record = rowToFileRecord(row as Record<string, string | number>);
      scored.push({ record, similarity: dot });
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, limit).map(({ record, similarity }) => ({ ...record, similarity }));
  }

  async queryFiles<TMetadata extends Array<keyof FileRecord>>(
    options: QueryOptions,
  ): Promise<QueryResult<TMetadata>> {
    const { filter, metadata, pageSize = 1_000, page: rawPage = 1 } = options;
    const page = Math.max(1, rawPage);

    const { where: whereClause, params: whereParams } = filterToSQL(filter);

    const countSQL = `SELECT COUNT(*) as count FROM files ${whereClause ? `WHERE ${whereClause}` : ""}`;
    const countResult = await (() =>
      this.db.get<{ count: number }>(countSQL, ...whereParams))();
    const total = countResult?.count ?? 0;

    // Sort by whether date is not null (non-null first), then by date descending
    const offset = (page - 1) * pageSize;
    const mainSQL = `
      SELECT * FROM files
      ${whereClause ? `WHERE ${whereClause}` : ""}
      ORDER BY
        (COALESCE(dateTaken, created, modified) IS NOT NULL) DESC,
        COALESCE(dateTaken, created, modified) DESC,
        folder ASC,
        fileName ASC
      LIMIT ? OFFSET ?
    `;

    const rows = await (() =>
      this.db.all<Record<string, unknown>>(mainSQL, ...whereParams, pageSize, offset))();

    const matchedFiles = rows.map((v) =>
      rowToFileRecord(v as Record<string, string | number>, metadata),
    );

    return {
      items: matchedFiles as Array<
        { folder: string; fileName: string } & Pick<FileRecord, TMetadata[number]>
      >,
      page,
      pageSize,
      total,
    } as QueryResult<TMetadata>;
  }

  async getDateRange(
    filter: FilterElement,
  ): Promise<{ minDate: Date | null; maxDate: Date | null }> {
    const { where: whereClause, params } = filterToSQL(filter);
    const sql = `
      SELECT
        MIN(dateTaken) AS minDate,
        MAX(dateTaken) AS maxDate
      FROM files
      WHERE dateTaken IS NOT NULL
      ${whereClause ? `AND ${whereClause}` : ""}
    `;

    const result = await this.db.get<{
      minDate: number | null;
      maxDate: number | null;
    }>(sql, ...params);

    return {
      minDate:
        result?.minDate !== null && result?.minDate !== undefined
          ? new Date(result.minDate)
          : null,
      maxDate:
        result?.maxDate !== null && result?.maxDate !== undefined
          ? new Date(result.maxDate)
          : null,
    };
  }

  async getDateHistogram(filter: FilterElement): Promise<DateHistogramResult> {
    const range = await this.getDateRange(filter);
    const minDate = range.minDate?.getTime() ?? null;
    const maxDate = range.maxDate?.getTime() ?? null;

    if (minDate === null || maxDate === null || minDate === maxDate) {
      return { buckets: [], bucketSizeMs: 0, minDate, maxDate, grouping: "day" };
    }

    const spanMs = maxDate - minDate;
    const dayMs = 24 * 60 * 60 * 1000;
    const spanDays = spanMs / dayMs;
    const monthDiff = (dateA: number, dateB: number) => {
      const a = new Date(dateA);
      const b = new Date(dateB);
      return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
    };

    // If the range is tight (within ~2 months) keep daily granularity; otherwise month buckets.
    const grouping: "day" | "month" =
      monthDiff(minDate, maxDate) <= 2 || spanDays <= 120 ? "day" : "month";
    const bucketFormat = grouping === "day" ? "%Y-%m-%d" : "%Y-%m-01";

    const { where: whereClause, params } = filterToSQL(filter);
    const rows = await this.db.all<{ bucket: string; count: number }>(
      `SELECT
            strftime('${bucketFormat}', datetime(dateTaken / 1000, 'unixepoch')) AS bucket,
            COUNT(*) AS count
          FROM files
          WHERE dateTaken IS NOT NULL
          ${whereClause ? `AND ${whereClause}` : ""}
          GROUP BY bucket
          ORDER BY bucket`,
      ...params,
    );

    const buckets = rows.map(({ bucket, count }) => {
      const start =
        grouping === "day"
          ? Date.UTC(
              Number(bucket.slice(0, 4)),
              Number(bucket.slice(5, 7)) - 1,
              Number(bucket.slice(8, 10)),
            )
          : Date.UTC(Number(bucket.slice(0, 4)), Number(bucket.slice(5, 7)) - 1, 1);

      const end =
        grouping === "day"
          ? start + dayMs
          : Date.UTC(Number(bucket.slice(0, 4)), Number(bucket.slice(5, 7)), 1);

      return { start, end, count };
    });

    const bucketSizeMs =
      grouping === "day" ? dayMs : buckets[0] ? buckets[0].end - buckets[0].start : 0;

    return { buckets, bucketSizeMs, minDate, maxDate, grouping };
  }

  async getSize(): Promise<number> {
    const result = await this.db.get<{ count: number }>(
      "SELECT COUNT(*) as count FROM files",
    );
    return result?.count ?? 0;
  }

  async optimize(): Promise<void> {
    await this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    await this.db.exec("PRAGMA optimize");
    await this.db.exec("VACUUM");
  }

  async getOnDiskSize(): Promise<{
    mainDb: number;
    walFile: number;
    shmFile: number;
    total: number;
  }> {
    const getFileSize = async (filePath: string): Promise<number> => {
      try {
        const fileStat = await stat(filePath);
        return fileStat.size;
      } catch {
        return 0;
      }
    };

    const [mainDb, walFile, shmFile] = await Promise.all([
      getFileSize(this.dbFilePath),
      getFileSize(`${this.dbFilePath}-wal`),
      getFileSize(`${this.dbFilePath}-shm`),
    ]);

    return { mainDb, walFile, shmFile, total: mainDb + walFile + shmFile };
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
