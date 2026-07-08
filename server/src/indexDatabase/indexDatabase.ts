import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { CACHE_DIR } from "../common/cacheUtils.ts";
import { AsyncSqlite } from "../common/asyncSqlite.ts";
import { runWithoutRequestAbortSignal } from "../common/requestAbort.ts";
import { mimeTypeForFilename } from "../fileHandling/mimeTypes.ts";
import { MetadataGroups, type FileRecord } from "./fileRecord.type.ts";
import { filterToSQL } from "./filterToSQL.ts";
import {
  type DateHistogramResult,
  type DateHistogramGrouping,
  type FaceClusterCentroid,
  type FaceClusterDetailResult,
  type FaceClusterFace,
  type FaceClusterSummary,
  type FaceClusterPCAResult,
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
import { FaceClusterEngine, toAlignedFloat32 } from "./faceClusterEngine.ts";
import { tables } from "./tables.ts";
import { computePCA3D } from "./pca.ts";
import { getLogger } from "../observability/logger.ts";

const log = getLogger("IndexDatabase");

// Columns to read for file queries: everything except the embedding BLOBs. Each
// row carries a ~2 KB imageEmbedding (and audioEmbedding) that no read path
// consumes, so `SELECT *` would drag megabytes of vector data off disk per page.
// rowToFileRecord never looks at these columns, so omitting them is transparent.
const FILE_QUERY_COLUMNS = tables.files.columns
  .filter((column) => column.type !== "BLOB")
  .map((column) => column.name)
  .join(", ");

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

const normalizeTranscriptSearchText = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const tokenizeTranscriptSearchText = (value: string): string[] =>
  [...new Set(normalizeTranscriptSearchText(value).split(" ").filter(Boolean))];

const countWholeWordOccurrences = (text: string, term: string): number => {
  if (!text || !term) return 0;

  let matches = 0;
  let fromIndex = 0;
  while (true) {
    const index = text.indexOf(term, fromIndex);
    if (index === -1) return matches;

    const beforeOk = index === 0 || text[index - 1] === " ";
    const afterIndex = index + term.length;
    const afterOk = afterIndex === text.length || text[afterIndex] === " ";
    if (beforeOk && afterOk) {
      matches += 1;
    }
    fromIndex = index + term.length;
  }
};

const scoreTranscriptMatch = (query: string, transcript: string): number => {
  const normalizedQuery = normalizeTranscriptSearchText(query);
  const normalizedTranscript = normalizeTranscriptSearchText(transcript);
  const terms = tokenizeTranscriptSearchText(normalizedQuery);
  if (!normalizedQuery || !normalizedTranscript || terms.length === 0) return 0;

  const termOccurrences = terms.map((term) => countWholeWordOccurrences(normalizedTranscript, term));
  const matchedTerms = termOccurrences.filter((count) => count > 0).length;
  if (matchedTerms === 0) return 0;
  if (terms.length > 1 && matchedTerms < terms.length) return 0;

  const phraseOccurrences = countWholeWordOccurrences(normalizedTranscript, normalizedQuery);
  const extraOccurrences = Math.max(
    0,
    termOccurrences.reduce((sum, count) => sum + count, 0) - matchedTerms,
  );

  return clamp01(
    0.55 +
      (0.25 * matchedTerms) / terms.length +
      Math.min(0.12, phraseOccurrences * 0.12) +
      Math.min(0.08, extraOccurrences * 0.04),
  );
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

// At a real library's scale (~316k faces) the greedy clustering produces a
// huge tail of tiny clusters — measured ~113k total, ~90k of them singletons
// (mostly low-confidence junk detections). Hiding single-face clusters keeps
// the People response meaningful and small; the faces still exist and show up
// the moment a second face of that person is found.
const MIN_FACE_CLUSTER_SIZE = 2;
const MIN_FACE_CLUSTER_PCA_SIZE = 100;
const FACE_CLUSTER_PCA_NEIGHBORS = 10;

// Caps the summary's cluster list (ordered by size, so this is "the 1000
// biggest people") and the detail's face list. Totals in the response still
// reflect the uncapped numbers. Without caps the summary JSON carried tens of
// thousands of clusters (megabytes) and a big person's detail tens of
// thousands of face entries.
const MAX_FACE_CLUSTERS_LISTED = 1000;
const MAX_FACES_IN_CLUSTER_DETAIL = 2000;
const MAX_MERGE_SUGGESTIONS = 6;

// Face rows are stored per file; cluster ids are exposed to the client as
// opaque strings. Keep the "person-" prefix stable — it's part of the API.
const faceClusterIdToString = (clusterId: number) => `person-${clusterId}`;
const faceClusterIdFromString = (clusterId: string): number | null => {
  const match = /^person-(\d+)$/.exec(clusterId);
  if (!match) return null;
  return Number(match[1]);
};

type FaceClusterPCASeed = {
  id: string;
  clusterId: number;
  personId: number | null;
  count: number;
  name: string | null;
  representative: FaceClusterFace;
  vector: Float32Array<ArrayBuffer>;
};

const normalizeFaceClusterCentroid = (
  vector: Float32Array<ArrayBuffer>,
): Float32Array<ArrayBuffer> => {
  let magnitude = 0;
  for (let i = 0; i < vector.length; i++) magnitude += vector[i] * vector[i];
  magnitude = Math.sqrt(magnitude);
  if (magnitude < 1e-10) return vector;
  const out = new Float32Array(vector.length) as Float32Array<ArrayBuffer>;
  for (let i = 0; i < vector.length; i++) out[i] = vector[i] / magnitude;
  return out;
};

const dotFaceClusterVectors = (
  a: Float32Array<ArrayBuffer>,
  b: Float32Array<ArrayBuffer>,
): number => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
};

const faceRowToClusterFace = (row: {
  folder: string;
  fileName: string;
  boxX: number;
  boxY: number;
  boxWidth: number;
  boxHeight: number;
  mimeType: string | null;
  dimensionWidth: number | null;
  dimensionHeight: number | null;
  regions: string | null;
}): FaceClusterFace => ({
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
});

const formatYearRangeLabel = (minDate: number | null, maxDate: number | null): string | null => {
  if (
    minDate === null ||
    maxDate === null ||
    !Number.isFinite(minDate) ||
    !Number.isFinite(maxDate)
  ) {
    return null;
  }

  const startYear = new Date(minDate).getUTCFullYear();
  const endYear = new Date(maxDate).getUTCFullYear();
  return startYear === endYear ? String(startYear) : `${startYear}-${endYear}`;
};

type StatusCounts = {
  allEntries: number;
  imageEntries: number;
  videoEntries: number;
  missingFileMetadata: number;
  missingMediaMetadata: number;
  missingThumbnails: number;
  missingFaceDetection: number;
};

export class IndexDatabase {
  public readonly storagePath: string;
  private db!: AsyncSqlite;
  get asyncSqlite(): AsyncSqlite { return this.db; }
  private dbFilePath!: string;
  private walCheckpointTimer?: ReturnType<typeof setInterval>;
  // The status counts come from a full-table-scan aggregate. Every active
  // background task asks for them on each status poll, so without coordination
  // the same heavy scan runs several times concurrently while the DB is already
  // busy indexing. De-duplicate concurrent callers onto a single scan. (No
  // time-based cache: a sequential read after a write must reflect the write.)
  private statusCountsInflight?: Promise<StatusCounts>;
  private pcaCache: FaceClusterPCAResult | null = null;
  private pcaCacheInflight: Promise<FaceClusterPCAResult> | null = null;
  // Incremental face clustering: assignments are persisted on the faces rows
  // and centroids in the faceClusters table, so People queries are plain
  // indexed reads. See faceClusterEngine.ts.
  private faceClusters!: FaceClusterEngine;

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
        // Cap the on-disk WAL after a checkpoint. Without this SQLite leaves the
        // WAL at its high-water mark even once frames are written back, so a one-
        // time spike (or a stalled checkpoint) stays on disk forever.
        "journal_size_limit = 67108864",
      ],
      customFunctions: [
        { name: "REGEXP", options: { deterministic: true }, type: "regexp" },
        {
          name: "cosine_similarity",
          options: { deterministic: true },
          type: "cosine_similarity",
        },
        {
          // Image CLIP embeddings are stored as packed Float32 (see
          // saveImageEmbedding); this variant reads them with the correct stride
          // so similarity can be ranked inside SQL.
          name: "cosine_similarity_f32",
          options: { deterministic: true },
          type: "cosine_similarity_f32",
        },
      ],
    });

    await prepareTables(this.db);

    this.faceClusters = new FaceClusterEngine(this.db);

    await this.db.get<{ count: number }>("SELECT COUNT(*) as count FROM files");

    // Clean up any leftover zombie WAL from the previous run before starting
    // the periodic maintenance timer.
    await this.checkpointWal();
    this.startWalMaintenance();

    // Warm the PCA cache in the background so the first UI request is instant.
    this.computePCACache()
      .then((result) => { this.pcaCache = result; })
      .catch(() => { /* non-fatal — will recompute on first request */ });
  }

  // Passive autocheckpoints (wal_autocheckpoint) abort whenever a reader holds a
  // snapshot. The dedicated read connection services a near-constant stream of
  // background queries, so passive checkpoints get starved and the WAL grows
  // without bound (observed at ~1 GB). A periodic TRUNCATE checkpoint on the
  // write connection writes committed frames back into the main DB and resets
  // the WAL file during the gaps between readers.
  private startWalMaintenance(): void {
    const intervalMs =
      Number(process.env.PHOTRIX_WAL_CHECKPOINT_INTERVAL_MS) || 60_000;
    if (intervalMs <= 0) return;
    this.walCheckpointTimer = setInterval(() => {
      void this.checkpointWal();
    }, intervalMs);
    this.walCheckpointTimer.unref?.();
  }

  /**
   * Write back reclaimable WAL frames and physically truncate the WAL file.
   *
   * TRUNCATE mode checkpoints all frames AND resets the WAL write position to
   * frame 0, but only if no reader holds a WAL snapshot at that moment. The
   * long-lived read worker holds an SHM lock for the lifetime of its
   * connection, so TRUNCATE is blocked whenever the read worker is mid-query.
   * Retrying with short gaps gives the checkpoint a window between read-query
   * batches (which last milliseconds) to grab the lock and physically shrink
   * the file. Without physical truncation, SQLite keeps the WAL at its peak
   * high-water mark even after all frames are checkpointed.
   */
  async checkpointWal(): Promise<void> {
    const maxAttempts = 5;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const result = await this.db.getFromWriteWorker<{
          busy: number;
          log: number;
          checkpointed: number;
        }>("PRAGMA wal_checkpoint(TRUNCATE)");
        if (result && result.busy === 0) {
          // Checkpoint wrote new DB pages that may include freshly indexed
          // embeddings. Re-warm the scan cache so those new pages stay hot
          // and the next search doesn't hit a cold page-cache miss.
          if (result.checkpointed > 0) {
            void this.warmSemanticSearch().catch(() => {});
          }
          return;
        }
      } catch (err) {
        log.warn({ err }, "WAL checkpoint failed");
        return;
      }
      if (attempt < maxAttempts - 1) {
        await new Promise<void>((r) => setTimeout(r, 50));
      }
    }
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
    ]);
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

  async fileMatchesFilter(subPath: string, filter: FilterElement): Promise<boolean> {
    const { folder, fileName } = splitPath(subPath);
    const combined: FilterElement = {
      operation: "and",
      conditions: [filter, { folder, fileName } as FilterElement],
    };
    const { where, params } = filterToSQL(combined);
    const result = await this.db.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM files${where ? ` WHERE ${where}` : ""}`,
      ...params,
    );
    return (result?.count ?? 0) > 0;
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

  async getStatusCounts(): Promise<StatusCounts> {
    if (this.statusCountsInflight) {
      return this.statusCountsInflight;
    }

    // Shared across concurrent callers: don't let the first caller's request
    // abort reject the promise everyone else is awaiting.
    this.statusCountsInflight = runWithoutRequestAbortSignal(() =>
      this.computeStatusCounts(),
    ).finally(() => {
      this.statusCountsInflight = undefined;
    });

    return this.statusCountsInflight;
  }

  private async computeStatusCounts(): Promise<StatusCounts> {
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

    // Re-detection replaces this file's face rows; subtract the outgoing faces
    // from their clusters' running means so the replacements don't count twice.
    await this.withdrawFaceClusterAssignments(folder, fileName);

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
    this.invalidateFaceClusterPCACache();

    // Assign the fresh faces to clusters right away so the People tab reflects
    // new detections without waiting for the backfill task. Best-effort: on
    // failure the rows stay clusterId NULL and the backfill picks them up.
    try {
      const inserted = await this.db.all<{ id: number; embedding: Buffer }>(
        "SELECT id, embedding FROM faces WHERE folder = ? AND fileName = ? AND LENGTH(embedding) > 0",
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
        `SELECT clusterId, embedding FROM faces
         WHERE folder = ? AND fileName = ? AND clusterId IS NOT NULL AND LENGTH(embedding) > 0`,
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
    this.invalidateFaceClusterPCACache();
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
    await this.db.run("DELETE FROM audioSegments WHERE folder = ? AND fileName = ?", [
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
        {
          sql: "DELETE FROM audioSegments WHERE folder = ? AND fileName = ?",
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
      {
        sql: "DELETE FROM audioSegments WHERE folder LIKE ? ESCAPE '\\'",
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

  async allFiles(): Promise<FileRecord[]> {
    const rows =
      await this.db.all<Record<string, string | number>>("SELECT * FROM files");
    return rows.map((row) => rowToFileRecord(row));
  }

  /**
   * Returns the canonical relativePaths of every indexed file, optionally
   * scoped to a subfolder. Used to reconcile the index against the filesystem
   * so entries for moved/deleted files can be pruned.
   */
  async getIndexedPaths(subFolder?: string): Promise<string[]> {
    const base = normalizeFolderPath(subFolder ?? "/");
    const rows =
      base === "/"
        ? await this.db.all<{ folder: string; fileName: string }>(
            "SELECT folder, fileName FROM files",
          )
        : await this.db.all<{ folder: string; fileName: string }>(
            "SELECT folder, fileName FROM files WHERE folder LIKE ? ESCAPE '\\'",
            `${escapeLikeLiteral(base)}%`,
          );
    return rows.map((row) => joinPath(row.folder, row.fileName));
  }

  async getFolders(
    relativePath: string,
    filter: FilterElement = {},
  ): Promise<Array<{ name: string; count: number }>> {
    const base = normalizeFolderPath(relativePath);
    const { where: whereClause, params: whereParams } = filterToSQL(filter);
    const whereFragment = whereClause ? `AND (${whereClause})` : "";

    if (base === "/") {
      const rows = await this.db.all<{ folderName: string | null; count: number }>(
        `SELECT
          CASE 
          WHEN instr(substr(folder, 2), '/') > 0 
          THEN substr(folder, 2, instr(substr(folder, 2), '/') - 1)
          ELSE substr(folder, 2)
          END AS folderName,
          COUNT(*) AS count
        FROM files
        WHERE folder LIKE '/%' AND length(folder) > 1
          ${whereFragment}
        GROUP BY folderName
        ORDER BY folderName COLLATE NOCASE ASC`,
        ...whereParams,
      );
      return rows
        .filter(
          (row): row is { folderName: string; count: number } =>
            Boolean(row.folderName) && Number.isFinite(row.count),
        )
        .map((row) => ({ name: row.folderName, count: row.count }));
    }

    const escapedPrefix = escapeLikeLiteral(base);
    const prefixLen = base.length;
    const rows = await this.db.all<{ folderName: string | null; count: number }>(
      `SELECT
         substr(folder, ?, instr(substr(folder, ?), '/') - 1) AS folderName,
         COUNT(*) AS count
       FROM files
       WHERE folder LIKE ? ESCAPE '\\'
          AND length(folder) > ?
          AND instr(substr(folder, ?), '/') > 0
          ${whereFragment}
       GROUP BY folderName
       ORDER BY folderName COLLATE NOCASE ASC`,
      prefixLen + 1,
      prefixLen + 1,
      `${escapedPrefix}%`,
      prefixLen,
      prefixLen + 1,
      ...whereParams,
    );
    return rows
      .filter(
        (row): row is { folderName: string; count: number } =>
          Boolean(row.folderName) && Number.isFinite(row.count),
      )
      .map((row) => ({ name: row.folderName, count: row.count }));
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
  }): Promise<FaceClusterResult> {
    const { filter } = options;
    const { where: whereClause, params: whereParams } = filterToSQL(filter);

    // Step 1: per-cluster count + representative face id. SQLite bare-column
    // semantics: with a MAX() aggregate, non-aggregated columns take their
    // values from the row that produced the max — so `id` here is the face
    // with the highest centroid similarity per cluster (its representative).
    //
    // With no filter (the People tab's default) this skips the files join
    // entirely and runs as a pure scan of the by_cluster covering index —
    // ~0.1s over 316k faces. Any row fetch would drag ~4 KB embedding BLOB
    // pages along, which is what made the previous formulation take seconds.
    //
    // The filtered variant forces the join order: MATERIALIZED pins the
    // filtered file set, and CROSS JOIN makes it the driving table so faces
    // are probed through the by_file_v3 covering index. Left to itself the
    // planner drove the join from all ~300k clustered faces instead, fetching
    // each face row (and its embedding BLOB pages) to get folder/fileName —
    // ~14s vs ~0.2s under a face filter.
    const aggregateRows = whereClause
      ? await this.db.all<{ personId: number; count: number; id: number }>(
          `WITH filtered_files AS MATERIALIZED (
             SELECT folder, fileName FROM files WHERE ${whereClause}
           )
           SELECT
             COALESCE(faceClusters.personId, faces.clusterId) AS personId,
             COUNT(*) AS count,
             MAX(faces.clusterSimilarity) AS representativeSimilarity,
             faces.id AS id
           FROM filtered_files
           CROSS JOIN faces
              ON faces.folder = filtered_files.folder
             AND faces.fileName = filtered_files.fileName
           JOIN faceClusters
             ON faceClusters.id = faces.clusterId
           WHERE faces.clusterId > 0
           GROUP BY COALESCE(faceClusters.personId, faces.clusterId)
           HAVING COUNT(*) >= ${MIN_FACE_CLUSTER_SIZE}
           ORDER BY COUNT(*) DESC, personId`,
          ...whereParams,
        )
      : await this.db.all<{ personId: number; count: number; id: number }>(
          `SELECT
             COALESCE(faceClusters.personId, faces.clusterId) AS personId,
             COUNT(*) AS count,
             MAX(faces.clusterSimilarity) AS representativeSimilarity,
             faces.id AS id
            FROM faces
           JOIN faceClusters
             ON faceClusters.id = faces.clusterId
           WHERE clusterId > 0
           GROUP BY COALESCE(faceClusters.personId, faces.clusterId)
           HAVING COUNT(*) >= ${MIN_FACE_CLUSTER_SIZE}
           ORDER BY COUNT(*) DESC, personId`,
        );

    // Same join-order forcing as above. Only faces that pass the clusterId IS
    // NULL index constraint get a row fetch (for the LENGTH check), so the
    // BLOB drag is limited to the actual pending backlog. Without a filter the
    // needing_cluster partial index answers the count directly.
    const pendingRow = whereClause
      ? await this.db.get<{ count: number }>(
          `WITH filtered_files AS MATERIALIZED (
             SELECT folder, fileName FROM files WHERE ${whereClause}
           )
           SELECT COUNT(*) AS count
           FROM filtered_files
           CROSS JOIN faces
             ON faces.folder = filtered_files.folder
            AND faces.fileName = filtered_files.fileName
           WHERE faces.clusterId IS NULL AND LENGTH(faces.embedding) > 0`,
          ...whereParams,
        )
      : await this.db.get<{ count: number }>(
          `SELECT COUNT(*) AS count FROM faces
           WHERE clusterId IS NULL AND LENGTH(embedding) > 0`,
        );

    // Step 2: hydrate the representative faces — only for the clusters the
    // response actually lists.
    const listed = aggregateRows.slice(0, MAX_FACE_CLUSTERS_LISTED);
    const representatives = new Map<number, FaceClusterFace>();
    const clusterNames = new Map<number, string | null>();
    if (listed.length) {
      const representativeRows = await this.db.all<{
        id: number;
        folder: string;
        fileName: string;
        boxX: number;
        boxY: number;
        boxWidth: number;
        boxHeight: number;
        mimeType: string | null;
        dimensionWidth: number | null;
        dimensionHeight: number | null;
        regions: string | null;
      }>(
        `SELECT
           faces.id AS id,
           faces.folder,
           faces.fileName,
           faces.boxX,
           faces.boxY,
           faces.boxWidth,
           faces.boxHeight,
           files.mimeType,
           files.dimensionsWidth AS dimensionWidth,
           files.dimensionsHeight AS dimensionHeight,
           files.regions
         FROM faces
         JOIN files
           ON files.folder = faces.folder
          AND files.fileName = faces.fileName
         WHERE faces.id IN (${listed.map(() => "?").join(", ")})`,
        ...listed.map((row) => row.id),
      );
      for (const row of representativeRows) {
        representatives.set(row.id, faceRowToClusterFace(row));
      }

      const nameRows = await this.db.all<{ id: number; name: string | null }>(
        `SELECT id, name FROM faceClusters WHERE id IN (${listed.map(() => "?").join(", ")})`,
        ...listed.map((row) => row.personId),
      );
      for (const row of nameRows) {
        clusterNames.set(row.id, row.name);
      }
    }

    const clusters = listed.flatMap((row) => {
      const representative = representatives.get(row.id);
      if (!representative) return [];
      return [
        {
          id: faceClusterIdToString(row.personId),
          count: row.count,
          representative,
          name: clusterNames.get(row.personId) ?? null,
        },
      ];
    });

    return {
      clusters,
      totalFaces: aggregateRows.reduce((sum, row) => sum + row.count, 0),
      totalClusters: aggregateRows.length,
      pendingFaces: pendingRow?.count ?? 0,
    };
  }

  async getFaceClusterDetail(options: {
    filter: QueryOptions["filter"];
    clusterId: string;
  }): Promise<FaceClusterDetailResult> {
    const { filter, clusterId } = options;
    const numericClusterId = faceClusterIdFromString(clusterId);
    if (numericClusterId === null || numericClusterId <= 0) {
      return { cluster: null };
    }

    const clusterRow = await this.db.get<{ id: number; personId: number | null }>(
      "SELECT id, personId FROM faceClusters WHERE id = ?",
      numericClusterId,
    );
    if (!clusterRow) {
      return { cluster: null };
    }

    const effectivePersonId = clusterRow.personId ?? clusterRow.id;

    const { where: whereClause, params: whereParams } = filterToSQL(filter);

    // The `limited` CTE selects the top-N face ids entirely inside covering
    // indexes (by_cluster unfiltered; filtered_files probing by_file_v3 under
    // a filter — MATERIALIZED + CROSS JOIN force that join order, see
    // queryFaceClusters). Only the N surviving rows are then fetched from
    // faces/files for box and dimension columns, keeping the embedding-BLOB
    // page drag proportional to the response, not the cluster size. The
    // redundant clusterId > 0 term lets the planner prove the by_cluster
    // partial index applies even though the cluster id is a bound parameter.
    const limitedCTE = whereClause
      ? `WITH filtered_files AS MATERIALIZED (
           SELECT folder, fileName FROM files WHERE ${whereClause}
          ),
          limited AS (
            SELECT faces.id AS id
            FROM filtered_files
            CROSS JOIN faces
              ON faces.folder = filtered_files.folder
             AND faces.fileName = filtered_files.fileName
            JOIN faceClusters
              ON faceClusters.id = faces.clusterId
            WHERE faces.clusterId > 0
              AND COALESCE(faceClusters.personId, faces.clusterId) = ?
            ORDER BY faces.clusterSimilarity DESC, faces.id
            LIMIT ${MAX_FACES_IN_CLUSTER_DETAIL}
          )`
      : `WITH limited AS (
           SELECT faces.id AS id
           FROM faces
           JOIN faceClusters
             ON faceClusters.id = faces.clusterId
           WHERE faces.clusterId > 0
             AND COALESCE(faceClusters.personId, faces.clusterId) = ?
           ORDER BY faces.clusterSimilarity DESC, faces.id
           LIMIT ${MAX_FACES_IN_CLUSTER_DETAIL}
         )`;

    const rows = await this.db.all<{
      folder: string;
      fileName: string;
      boxX: number;
      boxY: number;
      boxWidth: number;
      boxHeight: number;
      mimeType: string | null;
      dimensionWidth: number | null;
      dimensionHeight: number | null;
      regions: string | null;
    }>(
      `${limitedCTE}
       SELECT
         faces.folder,
         faces.fileName,
         faces.boxX,
         faces.boxY,
         faces.boxWidth,
         faces.boxHeight,
         files.mimeType,
         files.dimensionsWidth AS dimensionWidth,
         files.dimensionsHeight AS dimensionHeight,
         files.regions
       FROM limited
       JOIN faces
         ON faces.id = limited.id
       JOIN files
         ON files.folder = faces.folder
        AND files.fileName = faces.fileName
       ORDER BY faces.clusterSimilarity DESC, faces.id`,
      ...whereParams,
      effectivePersonId,
    );

    if (!rows.length) {
      return { cluster: null };
    }

    // `count` reflects the whole cluster within the filter even when the faces
    // list is capped; the count query is index-only, so it's cheap.
    const countRow = whereClause
      ? await this.db.get<{ count: number }>(
          `WITH filtered_files AS MATERIALIZED (
             SELECT folder, fileName FROM files WHERE ${whereClause}
           )
           SELECT COUNT(*) AS count
           FROM filtered_files
           CROSS JOIN faces
             ON faces.folder = filtered_files.folder
            AND faces.fileName = filtered_files.fileName
           JOIN faceClusters
             ON faceClusters.id = faces.clusterId
           WHERE COALESCE(faceClusters.personId, faces.clusterId) = ?
             AND faces.clusterId > 0`,
          ...whereParams,
          effectivePersonId,
        )
      : await this.db.get<{ count: number }>(
          `SELECT COUNT(*) AS count
           FROM faces
           JOIN faceClusters
             ON faceClusters.id = faces.clusterId
           WHERE faces.clusterId > 0
             AND COALESCE(faceClusters.personId, faces.clusterId) = ?`,
          effectivePersonId,
        );

    const faces = rows.map(faceRowToClusterFace);
    const nameRow = await this.db.get<{ name: string | null }>(
      "SELECT name FROM faceClusters WHERE id = ?",
      effectivePersonId,
    );

    const centroidAggregateRows = whereClause
      ? await this.db.all<{ clusterId: number; count: number; id: number }>(
          `WITH filtered_files AS MATERIALIZED (
             SELECT folder, fileName FROM files WHERE ${whereClause}
           )
           SELECT
             faces.clusterId AS clusterId,
             COUNT(*) AS count,
             MAX(faces.clusterSimilarity) AS representativeSimilarity,
             faces.id AS id
           FROM filtered_files
           CROSS JOIN faces
             ON faces.folder = filtered_files.folder
            AND faces.fileName = filtered_files.fileName
           JOIN faceClusters
             ON faceClusters.id = faces.clusterId
           WHERE faces.clusterId > 0
             AND COALESCE(faceClusters.personId, faces.clusterId) = ?
           GROUP BY faces.clusterId
           ORDER BY COUNT(*) DESC, faces.clusterId`,
          ...whereParams,
          effectivePersonId,
        )
      : await this.db.all<{ clusterId: number; count: number; id: number }>(
          `SELECT
             faces.clusterId AS clusterId,
             COUNT(*) AS count,
             MAX(faces.clusterSimilarity) AS representativeSimilarity,
             faces.id AS id
           FROM faces
           JOIN faceClusters
             ON faceClusters.id = faces.clusterId
           WHERE faces.clusterId > 0
             AND COALESCE(faceClusters.personId, faces.clusterId) = ?
           GROUP BY faces.clusterId
           ORDER BY COUNT(*) DESC, faces.clusterId`,
          effectivePersonId,
        );

    const centroidRepresentatives = new Map<number, FaceClusterFace>();
    if (centroidAggregateRows.length > 0) {
      const representativeRows = await this.db.all<{
        id: number;
        folder: string;
        fileName: string;
        boxX: number;
        boxY: number;
        boxWidth: number;
        boxHeight: number;
        mimeType: string | null;
        dimensionWidth: number | null;
        dimensionHeight: number | null;
        regions: string | null;
      }>(
        `SELECT
           faces.id AS id,
           faces.folder,
           faces.fileName,
           faces.boxX,
           faces.boxY,
           faces.boxWidth,
           faces.boxHeight,
           files.mimeType,
           files.dimensionsWidth AS dimensionWidth,
           files.dimensionsHeight AS dimensionHeight,
           files.regions
         FROM faces
         JOIN files
           ON files.folder = faces.folder
          AND files.fileName = faces.fileName
         WHERE faces.id IN (${centroidAggregateRows.map(() => "?").join(", ")})`,
        ...centroidAggregateRows.map((row) => row.id),
      );
      for (const row of representativeRows) {
        centroidRepresentatives.set(row.id, faceRowToClusterFace(row));
      }
    }

    const centroids: FaceClusterCentroid[] = centroidAggregateRows.flatMap((row) => {
      const representative = centroidRepresentatives.get(row.id);
      if (!representative) return [];
      return [{
        id: faceClusterIdToString(row.clusterId),
        count: row.count,
        representative,
      }];
    });

    const mergeSuggestions = await this.getMergeSuggestions(effectivePersonId);

    return {
      cluster: {
        id: faceClusterIdToString(effectivePersonId),
        count: countRow?.count ?? faces.length,
        representative: faces[0],
        faces,
        name: nameRow?.name ?? null,
        centroids,
        mergeSuggestions,
      },
    };
  }

  /**
   * Returns face cluster centroids projected to 3D via PCA. Result is cached
   * in memory after the first computation and invalidated whenever the
   * clustering task assigns new faces, so repeated calls are instant.
   */
  async getFaceClustersPCA(clusterId?: string): Promise<FaceClusterPCAResult> {
    if (clusterId) {
      return this.computeFocusedFaceClustersPCA(clusterId);
    }

    if (this.pcaCache) return this.pcaCache;

    // Coalesce concurrent requests onto a single in-flight computation
    if (this.pcaCacheInflight) return this.pcaCacheInflight;

    this.pcaCacheInflight = this.computePCACache().then((result) => {
      this.pcaCache = result;
      this.pcaCacheInflight = null;
      return result;
    });
    return this.pcaCacheInflight;
  }

  private invalidateFaceClusterPCACache() {
    this.pcaCache = null;
    this.pcaCacheInflight = null;
  }

  private buildFaceClustersPCAResult(
    seeds: FaceClusterPCASeed[],
    focusedClusterId: string | null = null,
  ): FaceClusterPCAResult {
    if (seeds.length === 0) return { points: [] };

    const coords = computePCA3D(seeds.map((seed) => seed.vector));
    const focusedIndex = focusedClusterId
      ? seeds.findIndex((seed) => seed.id === focusedClusterId)
      : -1;
    const focusOrigin = focusedIndex >= 0 ? coords[focusedIndex] : null;

    return {
      points: seeds.map((seed, index) => ({
        id: seed.id,
        count: seed.count,
        name: seed.name,
        representative: seed.representative,
        x: coords[index]![0] - (focusOrigin?.[0] ?? 0),
        y: coords[index]![1] - (focusOrigin?.[1] ?? 0),
        z: coords[index]![2] - (focusOrigin?.[2] ?? 0),
        focused: seed.id === focusedClusterId,
      })),
    };
  }

  private async computeFocusedFaceClustersPCA(clusterId: string): Promise<FaceClusterPCAResult> {
    const seeds = await this.listFaceClusterPCASeeds(MIN_FACE_CLUSTER_PCA_SIZE);
    const focusedSeed = seeds.find((seed) => seed.id === clusterId);
    if (!focusedSeed) return { points: [] };

    const focusedAndNeighbors = [
      focusedSeed,
      ...seeds
        .filter((seed) => seed.id !== clusterId)
        .map((seed) => ({
          seed,
          similarity: dotFaceClusterVectors(seed.vector, focusedSeed.vector),
        }))
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, FACE_CLUSTER_PCA_NEIGHBORS)
        .map(({ seed }) => seed),
    ];

    return this.buildFaceClustersPCAResult(focusedAndNeighbors, clusterId);
  }

  private async getMergeSuggestions(personId: number): Promise<FaceClusterSummary[]> {
    const seeds = await this.listFaceClusterPCASeeds(MIN_FACE_CLUSTER_SIZE);
    const personClusterRows = await this.db.all<{ id: number }>(
      `SELECT id FROM faceClusters
       WHERE id = ? OR personId = ?`,
      personId,
      personId,
    );
    const personClusterIds = new Set(personClusterRows.map((row) => row.id));
    const focusedSeeds = seeds.filter((seed) => personClusterIds.has(seed.clusterId));
    if (focusedSeeds.length === 0) return [];

    const suggestedSeeds = seeds
      .filter((seed) => seed.personId === null && !personClusterIds.has(seed.clusterId))
      .map((seed) => ({
        seed,
        similarity: Math.max(
          ...focusedSeeds.map((focusedSeed) => dotFaceClusterVectors(seed.vector, focusedSeed.vector)),
        ),
      }))
      .sort((a, b) => b.similarity - a.similarity || b.seed.count - a.seed.count)
      .slice(0, MAX_MERGE_SUGGESTIONS);

    const yearRangeLabels = await this.getFaceClusterYearRangeLabels(
      suggestedSeeds.map(({ seed }) => seed.clusterId),
    );

    return suggestedSeeds.map(({ seed }) => ({
        id: seed.id,
        count: seed.count,
        name: seed.name,
        representative: seed.representative,
        yearRangeLabel: yearRangeLabels.get(seed.clusterId) ?? null,
      }));
  }

  private async getFaceClusterYearRangeLabels(clusterIds: number[]): Promise<Map<number, string>> {
    const uniqueClusterIds = [...new Set(clusterIds.filter((clusterId) => clusterId > 0))];
    if (uniqueClusterIds.length === 0) return new Map();

    const rows = await this.db.all<{ clusterId: number; minDate: number | null; maxDate: number | null }>(
      `SELECT
         faces.clusterId AS clusterId,
         MIN(COALESCE(files.dateTaken, files.created, files.modified)) AS minDate,
         MAX(COALESCE(files.dateTaken, files.created, files.modified)) AS maxDate
       FROM faces
       JOIN files
         ON files.folder = faces.folder
        AND files.fileName = faces.fileName
       WHERE faces.clusterId IN (${uniqueClusterIds.map(() => "?").join(", ")})
       GROUP BY faces.clusterId`,
      ...uniqueClusterIds,
    );

    return new Map(
      rows.flatMap((row) => {
        const label = formatYearRangeLabel(row.minDate, row.maxDate);
        return label ? [[row.clusterId, label] as const] : [];
      }),
    );
  }

  private async listFaceClusterPCASeeds(minCount: number): Promise<FaceClusterPCASeed[]> {
    const centroidRows = await runWithoutRequestAbortSignal(() =>
      this.db.all<{
        id: number;
        personId: number | null;
        centroid: Buffer;
        weight: number;
        name: string | null;
      }>(
        `SELECT
           faceClusters.id,
           faceClusters.personId,
           faceClusters.centroid,
           faceClusters.weight,
           COALESCE(personRoots.name, faceClusters.name) AS name
         FROM faceClusters
         LEFT JOIN faceClusters AS personRoots
           ON personRoots.id = faceClusters.personId
         WHERE faceClusters.weight > 0`,
      ),
    );

    if (centroidRows.length === 0) return [];

    const countRows = await runWithoutRequestAbortSignal(() =>
      this.db.all<{ clusterId: number; count: number; id: number }>(
        `SELECT clusterId, COUNT(*) AS count, MAX(clusterSimilarity) AS _, id
         FROM faces
         WHERE clusterId > 0
         GROUP BY clusterId
         HAVING COUNT(*) >= ${minCount}`,
      ),
    );

    if (countRows.length === 0) return [];

    const countMap = new Map<number, { count: number; faceId: number }>();
    for (const row of countRows) {
      countMap.set(row.clusterId, { count: row.count, faceId: row.id });
    }

    type RepRow = {
      id: number;
      folder: string;
      fileName: string;
      boxX: number;
      boxY: number;
      boxWidth: number;
      boxHeight: number;
      mimeType: string | null;
      dimensionWidth: number | null;
      dimensionHeight: number | null;
      regions: string | null;
    };
    const repRows: RepRow[] = [];
    const faceIds = [...countMap.values()].map((value) => value.faceId);
    const CHUNK = 500;
    for (let i = 0; i < faceIds.length; i += CHUNK) {
      const chunk = faceIds.slice(i, i + CHUNK);
      const rows = await runWithoutRequestAbortSignal(() =>
        this.db.all<RepRow>(
          `SELECT
             faces.id AS id,
             faces.folder, faces.fileName,
             faces.boxX, faces.boxY, faces.boxWidth, faces.boxHeight,
             files.mimeType,
             files.dimensionsWidth AS dimensionWidth,
             files.dimensionsHeight AS dimensionHeight,
             files.regions
           FROM faces
           JOIN files ON files.folder = faces.folder AND files.fileName = faces.fileName
           WHERE faces.id IN (${chunk.map(() => "?").join(", ")})`,
          ...chunk,
        ),
      );
      repRows.push(...rows);
    }

    const repMap = new Map<number, FaceClusterFace>();
    for (const row of repRows) repMap.set(row.id, faceRowToClusterFace(row));

    return centroidRows.flatMap((row) => {
      const countEntry = countMap.get(row.id);
      if (!countEntry) return [];
      const representative = repMap.get(countEntry.faceId);
      if (!representative) return [];
      return [{
        id: faceClusterIdToString(row.id),
        clusterId: row.id,
        personId: row.personId,
        count: countEntry.count,
        name: row.name ?? null,
        representative,
        vector: normalizeFaceClusterCentroid(
          toAlignedFloat32(row.centroid) as Float32Array<ArrayBuffer>,
        ),
      }];
    }).sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  }

  private async computePCACache(): Promise<FaceClusterPCAResult> {
    const seeds = await this.listFaceClusterPCASeeds(MIN_FACE_CLUSTER_PCA_SIZE);
    return this.buildFaceClustersPCAResult(seeds);
  }

  /**
   * Assigns one batch of not-yet-clustered faces (best detections first, so
   * early centroids are built from confident faces) to persistent clusters.
   * Returns the number of faces handled; 0 means the backlog is drained.
   *
   * The id list and the embedding fetch are separate queries on purpose:
   * sorting must not drag 4 KB embedding BLOBs through the sorter (that was
   * the dominant cost of the old per-request clustering).
   */
  async clusterPendingFaces(batchSize = 256): Promise<number> {
    const idRows = await this.db.all<{ id: number }>(
      `SELECT id FROM faces
       WHERE clusterId IS NULL AND LENGTH(embedding) > 0
       ORDER BY confidence DESC
       LIMIT ?`,
      batchSize,
    );
    if (!idRows.length) return 0;

    const faces = await this.db.all<{ id: number; embedding: Buffer }>(
      `SELECT id, embedding FROM faces WHERE id IN (${idRows.map(() => "?").join(", ")})`,
      ...idRows.map((row) => row.id),
    );
    await this.faceClusters.assignFaces(faces);
    // Cluster membership changed — drop the PCA cache so the next request recomputes
    this.invalidateFaceClusterPCACache();
    return idRows.length;
  }

  async pruneEmptyFaceClusters(): Promise<void> {
    await this.faceClusters.pruneEmptyClusters();
    this.invalidateFaceClusterPCACache();
  }

  async renameCluster(clusterId: string, name: string | null): Promise<boolean> {
    const numericId = faceClusterIdFromString(clusterId);
    if (numericId === null || numericId <= 0) return false;

    const clusterRow = await this.db.get<{ id: number; personId: number | null }>(
      "SELECT id, personId FROM faceClusters WHERE id = ?",
      numericId,
    );
    if (!clusterRow) return false;

    const normalizedName = typeof name === "string" ? name.trim() || null : null;
    const effectivePersonId = clusterRow.personId ?? clusterRow.id;

    if (normalizedName === null) {
      if (clusterRow.personId === null) {
        await this.db.run("UPDATE faceClusters SET name = NULL WHERE id = ?", clusterRow.id);
      } else {
        await this.db.transaction([
          {
            sql: "UPDATE faceClusters SET name = NULL WHERE id = ? OR personId = ?",
            params: [effectivePersonId, effectivePersonId],
          },
          {
            sql: "UPDATE faceClusters SET personId = NULL WHERE personId = ?",
            params: [effectivePersonId],
          },
        ]);
      }
      this.invalidateFaceClusterPCACache();
      return true;
    }

    await this.db.transaction([
      {
        sql: "UPDATE faceClusters SET personId = ? WHERE id = ?",
        params: [effectivePersonId, effectivePersonId],
      },
      {
        sql: "UPDATE faceClusters SET name = ? WHERE id = ?",
        params: [normalizedName, effectivePersonId],
      },
      {
        sql: "UPDATE faceClusters SET name = NULL WHERE personId = ? AND id != ?",
        params: [effectivePersonId, effectivePersonId],
      },
    ]);

    this.invalidateFaceClusterPCACache();
    return true;
  }

  async mergeClusters(sourceClusterId: string, targetClusterId: string): Promise<boolean> {
    const sourceId = faceClusterIdFromString(sourceClusterId);
    const targetId = faceClusterIdFromString(targetClusterId);
    if (sourceId === null || targetId === null || sourceId <= 0 || targetId <= 0) return false;
    if (sourceId === targetId) return false;

    const [sourceRow, targetRow] = await Promise.all([
      this.db.get<{ id: number; personId: number | null }>(
        "SELECT id, personId FROM faceClusters WHERE id = ?",
        sourceId,
      ),
      this.db.get<{ id: number; personId: number | null }>(
        "SELECT id, personId FROM faceClusters WHERE id = ?",
        targetId,
      ),
    ]);
    if (!sourceRow || !targetRow) return false;

    const sourcePersonId = sourceRow.personId ?? sourceRow.id;
    const targetPersonId = targetRow.personId ?? targetRow.id;
    if (sourcePersonId === targetPersonId) return false;

    const [sourcePersonRow, targetPersonRow] = await Promise.all([
      this.db.get<{ name: string | null }>("SELECT name FROM faceClusters WHERE id = ?", sourcePersonId),
      this.db.get<{ name: string | null }>("SELECT name FROM faceClusters WHERE id = ?", targetPersonId),
    ]);

    const canonicalTargetId =
      (targetPersonRow?.name == null && sourcePersonRow?.name != null)
        ? sourcePersonId
        : targetPersonId;
    const movedPersonId = canonicalTargetId === sourcePersonId ? targetPersonId : sourcePersonId;
    const movedClusterRows = await this.db.all<{ id: number }>(
      `SELECT id FROM faceClusters
       WHERE id = ? OR personId = ?`,
      movedPersonId,
      movedPersonId,
    );
    if (movedClusterRows.length === 0) return false;

    const placeholders = movedClusterRows.map(() => "?").join(", ");
    await this.db.transaction([
      {
        sql: "UPDATE faceClusters SET personId = ? WHERE id = ?",
        params: [canonicalTargetId, canonicalTargetId],
      },
      {
        sql: `UPDATE faceClusters
              SET personId = ?, name = NULL
              WHERE id IN (${placeholders})`,
        params: [canonicalTargetId, ...movedClusterRows.map((row) => row.id)],
      },
      {
        sql: "UPDATE faceClusters SET name = NULL WHERE personId = ? AND id != ?",
        params: [canonicalTargetId, canonicalTargetId],
      },
    ]);

    this.invalidateFaceClusterPCACache();
    return true;
  }

  async separateCluster(clusterId: string): Promise<boolean> {
    const numericId = faceClusterIdFromString(clusterId);
    if (numericId === null || numericId <= 0) return false;

    const clusterRow = await this.db.get<{ id: number; personId: number | null }>(
      "SELECT id, personId FROM faceClusters WHERE id = ?",
      numericId,
    );
    if (!clusterRow || clusterRow.personId === null || clusterRow.personId === clusterRow.id) {
      return false;
    }

    await this.db.run(
      "UPDATE faceClusters SET personId = NULL, name = NULL WHERE id = ?",
      clusterRow.id,
    );
    this.invalidateFaceClusterPCACache();
    return true;
  }

  /** Cheap index-only counts — polled by the backfill task's status hook. */
  async getFaceClusteringProgress(): Promise<{ assigned: number; pending: number }> {
    const [assignedRow, pendingRow] = await Promise.all([
      this.db.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM faces WHERE clusterId > 0",
      ),
      this.db.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM faces WHERE clusterId IS NULL AND LENGTH(embedding) > 0",
      ),
    ]);
    return { assigned: assignedRow?.count ?? 0, pending: pendingRow?.count ?? 0 };
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

  async getFilesNeedingAudioTranscription(
    limit = 10,
  ): Promise<Array<{ relativePath: string }>> {
    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT folder, fileName FROM files
       WHERE exifProcessedAt IS NOT NULL
         AND audioTranscribedAt IS NULL
         AND (
           (mimeType LIKE 'video/%' AND audioCodec IS NOT NULL)
           OR mimeType LIKE 'audio/%'
         )
       ORDER BY audioTranscribeErrorAt IS NOT NULL, audioTranscribeErrorAt, folder, fileName
       LIMIT ?`,
      limit,
    );
    return rows.map((row) => ({
      relativePath: joinPath(row.folder as string, row.fileName as string),
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
    return rows.map((row) => ({ start: row.startTime, end: row.endTime, text: row.text }));
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
    const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    await this.db.run(
      `UPDATE files
       SET audioEmbedding = ?, audioEmbeddingProcessedAt = ?, audioEmbeddingErrorAt = NULL
       WHERE folder = ? AND fileName = ?`,
      buffer,
      Date.now(),
      folder,
      fileName,
    );
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
    await this.db.run(
      `UPDATE files SET audioEmbedding = NULL, audioEmbeddingProcessedAt = ?, audioEmbeddingErrorAt = NULL WHERE folder = ? AND fileName = ?`,
      Date.now(),
      folder,
      fileName,
    );
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

  async audioSemanticSearch(
    queryVector: Float32Array,
    filter: FilterElement,
    limit: number,
  ): Promise<Array<FileRecord & { similarity: number }>> {
    const { where: whereClause, params: whereParams } = filterToSQL(filter);

    const queryBuffer = Buffer.from(
      queryVector.buffer,
      queryVector.byteOffset,
      queryVector.byteLength,
    );

    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT *, cosine_similarity_f32(audioEmbedding, ?) AS similarity
       FROM files
       WHERE audioEmbedding IS NOT NULL
         AND (
           (mimeType LIKE 'video/%' AND audioCodec IS NOT NULL)
           OR mimeType LIKE 'audio/%'
         )
         ${whereClause ? `AND (${whereClause})` : ""}
       ORDER BY similarity DESC
       LIMIT ?`,
      queryBuffer,
      ...whereParams,
      limit,
    );

    return rows.map((row) => ({
      ...rowToFileRecord(row as Record<string, string | number>),
      similarity: typeof row.similarity === "number" ? row.similarity : 0,
    }));
  }

  async audioTranscriptSearch(
    query: string,
    filter: FilterElement,
    limit: number,
  ): Promise<Array<FileRecord & { similarity: number }>> {
    const { where: whereClause, params: whereParams } = filterToSQL(filter);
    const terms = tokenizeTranscriptSearchText(query);
    if (terms.length === 0) {
      return [];
    }

    const candidateLimit = Math.min(Math.max(limit * 10, limit), 500);
    const transcriptWhere = terms
      .map(() => "LOWER(audioTranscript) LIKE ? ESCAPE '\\'")
      .join(" AND ");
    const transcriptParams = terms.map((term) => `%${escapeLikeLiteral(term)}%`);

    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT *
       FROM files
        WHERE audioTranscript IS NOT NULL
          AND ${transcriptWhere}
          ${whereClause ? `AND (${whereClause})` : ""}
        LIMIT ?`,
      ...transcriptParams,
      ...whereParams,
      candidateLimit,
    );

    return rows
      .map((row) => {
        const record = rowToFileRecord(row as Record<string, string | number>);
        const similarity = scoreTranscriptMatch(query, String(row.audioTranscript ?? ""));
        return similarity > 0 ? { ...record, similarity } : null;
      })
      .filter((row): row is FileRecord & { similarity: number } => row !== null)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  async semanticSearch(
    queryVector: Float32Array,
    filter: FilterElement,
    limit: number,
  ): Promise<Array<FileRecord & { similarity: number }>> {
    const { where: whereClause, params: whereParams } = filterToSQL(filter);

    // Rank and truncate inside SQLite. The previous implementation pulled every
    // embedding-bearing row (BLOBs and all columns) onto the JS heap and scored
    // them here; on a large library that materialised the whole table twice (once
    // in the read worker, once cloned across the worker boundary) and exhausted
    // V8's heap. Pushing cosine_similarity_f32 into the ORDER BY ... LIMIT keeps
    // the per-row embedding work in C and returns only `limit` rows.
    const queryBuffer = Buffer.from(
      queryVector.buffer,
      queryVector.byteOffset,
      queryVector.byteLength,
    );

    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT *, cosine_similarity_f32(imageEmbedding, ?) AS similarity
       FROM files
       WHERE imageEmbedding IS NOT NULL
         AND (mimeType LIKE 'image/%')
         ${whereClause ? `AND (${whereClause})` : ""}
       ORDER BY similarity DESC
       LIMIT ?`,
      queryBuffer,
      ...whereParams,
      limit,
    );

    return rows.map((row) => ({
      ...rowToFileRecord(row as Record<string, string | number>),
      similarity: typeof row.similarity === "number" ? row.similarity : 0,
    }));
  }

  /**
   * Prime the OS page cache for image semantic search.
   *
   * `semanticSearch` scans every image-embedding BLOB (hundreds of MB on a large
   * library). Cold — right after a restart, before background analysis has
   * touched those pages — that read alone can exceed the search request timeout,
   * so the first user query times out and returns nothing. That is the dominant
   * cause of "semantic search failed" immediately after the server starts.
   *
   * Running one throwaway scan in the background at boot pulls the embedding
   * pages into cache so the first real query is warm. Best-effort: the score is
   * irrelevant (a zero query vector ranks nothing), the point is the read, and
   * any failure is swallowed so a warmup problem never blocks startup.
   */
  async warmSemanticSearch(): Promise<void> {
    // CLIP ViT-B-32 image-embedding dimension. An exact match is not required —
    // even a length-mismatched probe forces SQLite to load every embedding BLOB
    // to hand it to the scoring function — but matching keeps the scan realistic.
    const probe = new Float32Array(512);
    await this.semanticSearch(probe, {}, 1);
  }

  async queryFiles<TMetadata extends Array<keyof FileRecord>>(
    options: QueryOptions,
  ): Promise<QueryResult<TMetadata>> {
    const { filter, metadata, pageSize = 1_000, page: rawPage = 1, expandToFolder } = options;
    const page = Math.max(1, rawPage);

    const { where: whereClause, params: whereParams } = filterToSQL(filter);

    // When expandToFolder is enabled, wrap the filter in a folder-IN-subquery so
    // all files in a matched folder are returned, not just the matched files.
    const effectiveWhere =
      expandToFolder && whereClause
        ? `folder IN (SELECT DISTINCT folder FROM files WHERE ${whereClause})`
        : whereClause;

    const countSQL = `SELECT COUNT(*) as count FROM files ${effectiveWhere ? `WHERE ${effectiveWhere}` : ""}`;
    const countResult = await (() =>
      this.db.get<{ count: number }>(countSQL, ...whereParams))();
    const total = countResult?.count ?? 0;

    // Newest first. A DESC ordering already sorts NULL effective-dates last, so no
    // separate IS NOT NULL term is needed. This ORDER BY (and its folder/fileName
    // tiebreakers) is covered end-to-end by idx_files_sort_date, so SQLite walks
    // the index for the top N instead of scanning + temp-sorting the whole table.
    const offset = (page - 1) * pageSize;
    const mainSQL = `
      SELECT ${FILE_QUERY_COLUMNS} FROM files
      ${effectiveWhere ? `WHERE ${effectiveWhere}` : ""}
      ORDER BY
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
    // typeof(dateTaken) = 'integer' guards against rows where dateTaken was
    // written as a TEXT/ISO string. SQLite sorts TEXT above every INTEGER, so a
    // single stray string poisons MAX(dateTaken) with garbage.
    const sql = `
      SELECT
        MIN(dateTaken) AS minDate,
        MAX(dateTaken) AS maxDate
      FROM files
      WHERE dateTaken IS NOT NULL
      AND typeof(dateTaken) = 'integer'
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

  async getDateHistogram(
    filter: FilterElement,
    bucketCount = 40,
  ): Promise<DateHistogramResult> {
    const { where: whereClause, params } = filterToSQL(filter);
    // Only integer timestamps take part: guards against TEXT dateTaken values
    // that would poison MIN/MAX and the bucket math (see getDateRange).
    const baseWhere = `dateTaken IS NOT NULL AND typeof(dateTaken) = 'integer'${
      whereClause ? ` AND ${whereClause}` : ""
    }`;

    const stats = await this.db.get<{
      total: number;
      minDate: number | null;
      maxDate: number | null;
    }>(
      `SELECT COUNT(*) AS total, MIN(dateTaken) AS minDate, MAX(dateTaken) AS maxDate
         FROM files WHERE ${baseWhere}`,
      ...params,
    );

    const total = stats?.total ?? 0;
    const trueMin = stats?.minDate ?? null;
    const trueMax = stats?.maxDate ?? null;

    if (total === 0 || trueMin === null || trueMax === null || trueMin === trueMax) {
      return {
        buckets: [],
        bucketSizeMs: 0,
        minDate: trueMin,
        maxDate: trueMax,
        grouping: "day",
      };
    }

    // Trim sparse early outliers (e.g. one photo stamped 1899) that would
    // otherwise stretch the axis and squash the meaningful range. We drop the
    // lowest ~1% by clamping the domain start to that percentile, but keep the
    // true max so recent photos are never hidden.
    const nthValue = async (offset: number): Promise<number | null> => {
      const clamped = Math.min(Math.max(offset, 0), total - 1);
      const row = await this.db.get<{ dateTaken: number }>(
        `SELECT dateTaken FROM files WHERE ${baseWhere}
           ORDER BY dateTaken LIMIT 1 OFFSET ?`,
        ...params,
        clamped,
      );
      return row?.dateTaken ?? null;
    };

    const trimmedMin =
      total >= 50 ? ((await nthValue(Math.floor(total * 0.01))) ?? trueMin) : trueMin;

    const minDate = trimmedMin;
    const maxDate = trueMax;
    const spanMs = maxDate - minDate;

    if (spanMs <= 0) {
      return { buckets: [], bucketSizeMs: 0, minDate, maxDate, grouping: "day" };
    }

    // Equal-width buckets across the (trimmed) domain give a stable number of
    // readable bars regardless of how many years the library spans.
    const count = Math.min(Math.max(Math.round(bucketCount), 12), 80);
    const bucketSizeMs = spanMs / count;

    const rows = await this.db.all<{ idx: number; count: number }>(
      `SELECT
            MIN(CAST((dateTaken - ?) / ? AS INTEGER), ?) AS idx,
            COUNT(*) AS count
          FROM files
          WHERE ${baseWhere}
            AND dateTaken >= ?
          GROUP BY idx
          ORDER BY idx`,
      minDate,
      bucketSizeMs,
      count - 1,
      ...params,
      minDate,
    );

    const counts = new Array<number>(count).fill(0);
    for (const { idx, count: c } of rows) {
      if (idx >= 0 && idx < count) counts[idx] += c;
    }

    const buckets = counts.map((c, idx) => ({
      start: Math.round(minDate + idx * bucketSizeMs),
      end: Math.round(minDate + (idx + 1) * bucketSizeMs),
      count: c,
    }));

    const dayMs = 24 * 60 * 60 * 1000;
    const spanDays = spanMs / dayMs;
    const grouping: DateHistogramGrouping =
      spanDays <= 90 ? "day" : spanDays <= 3 * 365 ? "month" : "year";

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
