import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { CACHE_DIR } from "../common/cacheUtils.ts";
import { AsyncSqlite } from "../common/asyncSqlite.ts";
import { runWithoutRequestAbortSignal } from "../common/requestAbort.ts";
import { mimeTypeForFilename } from "../fileHandling/mimeTypes.ts";
import { MetadataGroups, type FileRecord } from "./fileRecord.type.ts";
import { filterToSQL } from "./filterToSQL.ts";
import { type DateHistogramResult, type DateHistogramGrouping, type FilterElement, type GeoClusterResult, type QueryOptions, type QueryResult, type SortOption } from "./indexDatabase.type.ts";
import {
  fileRecordToColumnNamesAndValues,
  rowToFileRecord,
} from "./rowFileRecordConversionFunctions.ts";
import { joinPath, normalizeFolderPath, splitPath } from "./utils/pathUtils.ts";
import { escapeLikeLiteral } from "./utils/sqlUtils.ts";
import { prepareTables } from "./prepareTables.ts";
import { migrateEmbeddingStorage } from "./migrateEmbeddingStorage.ts";
import { VectorIndex } from "./vectorIndex/vectorIndex.ts";
import { FaceStore } from "./faceStore.ts";
import { FaceClusterStore } from "./faceClusterStore.ts";
import { MomentStore } from "./momentStore.ts";
import { AnalysisStore } from "./analysisStore.ts";
import { FaceClusterEngine } from "./faceClusterEngine.ts";
import { migrateFaceVerdicts } from "./migrateFaceVerdicts.ts";
import { tables } from "./tables.ts";
import { getLogger } from "../observability/logger.ts";
import { attemptSync } from "../common/result.ts";
import { deleteFacesStatements } from "./deleteFacesStatements.ts";

const log = getLogger("IndexDatabase");


// PRAGMA user_version marking that the one-time EXIF re-extraction pass for the
// new human-authored `description` column has been queued. Bumps the monotonic
// scheme above MERGED_SIMILARITY_RESCORE_VERSION. Clears exifProcessedAt on
// already-processed images so processExifMetadata re-reads their headers and
// fills in `description` (and any other fields added since they were scanned).
const EXIF_DESCRIPTION_BACKFILL_VERSION = 3;

// PRAGMA user_version marking that HEIC/HEIF files have been re-queued for
// EXIF re-scan so the new embeddedVideoLength column (Samsung motion photos)
// gets populated for existing files.
const HEIC_EMBEDDED_VIDEO_BACKFILL_VERSION = 5;

// PRAGMA user_version marking that all images have been re-queued for EXIF
// re-scan so the `tags` column (XMP dc:subject / IPTC Keywords /
// lr:hierarchicalSubject — human-authored keyword/person tags, e.g. "Jeffrey
// Goodsell; Timothy Goodsell") gets backfilled. The `tags` field mapping in
// fileUtils.ts's exifFieldMapping has existed since before
// EXIF_DESCRIPTION_BACKFILL_VERSION (3) ran, but as of 2026-08-31 zero of
// ~195k indexed files had a non-null `tags` value even though exifr
// correctly extracts it from real library files on demand — the one full
// library re-scan that would have populated it (v3, for `description`) ran
// before the extraction path worked end-to-end (and separately, IPTC segment
// parsing was never enabled — see the `iptc: true` fix alongside this
// migration). Re-queuing is required, not just fixing the extractor, because
// nothing else invalidates exifProcessedAt on ordinary code changes.
const TAGS_BACKFILL_VERSION = 6;

// Columns to read for file queries. This used to exclude the embedding BLOBs
// explicitly — each row carried a ~2 KB imageEmbedding (and audioEmbedding) that
// no read path consumes, so `SELECT *` dragged megabytes of vector data off disk
// per page. The vectors now live in `fileEmbeddings`, so there is nothing left on
// `files` to exclude; the list stays explicit so a future BLOB column added here
// has to be a deliberate choice rather than something `SELECT *` picks up.
const FILE_QUERY_COLUMNS = tables.files.columns
  .map((column) => column.name)
  .join(", ");

// Effective capture date used for date sorting: prefer the EXIF date, fall back
// to filesystem timestamps. Shared by the ORDER BY builder below.
const SORT_DATE_EXPR = "COALESCE(dateTaken, created, modified)";

// Ceiling on map pins returned by one queryGeoClusters call. The caller picks a
// bucket size for the current viewport, so a well-behaved request lands far
// under this; the limit exists so a pathological bucket size cannot serialize an
// unbounded result set. Buckets are ordered by count, so the densest — the ones
// worth seeing — survive the cut, and the response's `total` still reflects
// every matching item so the client can say the view is limited.
const GEO_CLUSTER_LIMIT = 10_000;

// Separator joining folder and fileName inside queryGeoClusters' MIN() sample
// key. Must sort below every character a path can contain and never appear in
// one; see the query for why both properties matter.
const SAMPLE_KEY_SEPARATOR = "\u0001";

/**
 * Build the ORDER BY clause for `queryFiles`.
 *
 * The default (date, descending) is intentionally byte-for-byte identical to the
 * previous hard-coded ordering so it stays covered end-to-end by
 * idx_files_sort_date — SQLite walks the index for the top N instead of scanning
 * and temp-sorting the whole table. Other orderings fall back to a temp-sort,
 * which is acceptable for the less common cases.
 *
 * `relevance` is a semantic-search concept with no meaning for a plain library
 * query, so it degrades to the date ordering here.
 */
const buildQueryOrderBy = (sort?: SortOption): string => {
  const dir = sort?.direction === "asc" ? "ASC" : "DESC";
  const tiebreak = "folder ASC, fileName ASC";

  if (sort?.field === "rating") {
    // Unrated files (NULL) always sink to the bottom regardless of direction;
    // among rated files, order by the requested direction, then newest-first.
    return `rating IS NULL, rating ${dir}, ${SORT_DATE_EXPR} DESC, ${tiebreak}`;
  }

  if (sort?.field === "quality") {
    // Same NULL-always-last treatment as rating: a photo with no scored faces
    // has no quality signal at all, which is not the same as "bad quality", so
    // it must not win an ascending ("worst first") sort either.
    return `photoQualityScore IS NULL, photoQualityScore ${dir}, ${SORT_DATE_EXPR} DESC, ${tiebreak}`;
  }

  if (dir === "ASC") {
    // Ascending needs an explicit NULL guard: a plain ASC sorts NULL dates first,
    // but files with no known date belong at the end in either direction.
    return `${SORT_DATE_EXPR} IS NULL, ${SORT_DATE_EXPR} ASC, ${tiebreak}`;
  }

  // Newest first. A DESC ordering already sorts NULL effective-dates last, so no
  // separate IS NULL term is needed — and this exact shape is index-covered.
  return `${SORT_DATE_EXPR} DESC, ${tiebreak}`;
};

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
  get asyncSqlite(): AsyncSqlite {
    return this.db;
  }
  private dbFilePath!: string;
  private walCheckpointTimer?: ReturnType<typeof setInterval>;
  // In-memory copy of every CLIP/CLAP vector, so semantic search is one pass
  // over packed memory instead of a full-table SQL scan. Every write to
  // `fileEmbeddings` below is mirrored into it after the write commits.
  private vectorIndex!: VectorIndex;
  // The status counts come from a full-table-scan aggregate. Every active
  // background task asks for them on each status poll, and the status SSE stream
  // polls a few times a second, so without coordination the same heavy scan runs
  // repeatedly while the DB is already busy indexing. De-duplicate concurrent
  // callers onto a single scan, and briefly cache the result. All callers are
  // progress-display getStatus() methods where sub-second staleness is invisible,
  // so a short TTL bounds the load without any user-visible effect.
  private statusCountsInflight?: Promise<StatusCounts>;
  private statusCountsCache?: { value: StatusCounts; at: number };
  private static readonly STATUS_COUNTS_TTL_MS = 1_000;
  // Off-critical-path startup work kicked off by init() (one-time face-cluster
  // migrations + PCA warm). init() resolves without awaiting it so the HTTP
  // server binds immediately; tests can await this to observe the settled state.
  startupMaintenance: Promise<void> = Promise.resolve();
  // Cached decode of the `settings` row for the default exclusion filter
  // (feedback #95) — read on nearly every /api/files request, so this avoids
  // a DB round trip + JSON.parse per request. `undefined` means "not loaded
  // yet"; `null` means "loaded, no filter set". Invalidated by
  // setDefaultExclusionFilter.
  private defaultExclusionFilterCache: QueryOptions["filter"] | null | undefined =
    undefined;
  // Incremental face clustering: assignments are persisted on the faces rows
  // and centroids in the faceClusters table, so People queries are plain
  // indexed reads. See faceClusterEngine.ts.
  faces!: FaceStore;
  faceClusters!: FaceClusterStore;
  moments!: MomentStore;
  analysis!: AnalysisStore;
  // Set when a root file-system scan can't confirm the media root is actually
  // mounted (missing directory, or a scan that found zero files while the
  // index already has entries — the empty-mount-masquerading-as-real-library
  // failure mode). While true, fileSystemScanFolder refuses to prune missing
  // paths, so a transient unmount can't wipe the index. Cleared by the next
  // scan that finds files (or confirms a genuinely-empty, previously-empty
  // library). See docs/host-migration.md "Incident: DB got zeroed out".
  private _mediaRootUnavailable = false;
  get mediaRootUnavailable(): boolean {
    return this._mediaRootUnavailable;
  }
  setMediaRootUnavailable(value: boolean): void {
    if (value !== this._mediaRootUnavailable) {
      log.warn(
        { mediaRootUnavailable: value },
        value
          ? "Media root appears unavailable — index left unloaded, not pruned"
          : "Media root available again — resuming normal indexing",
      );
    }
    this._mediaRootUnavailable = value;
  }

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
        // Read through a memory map (one shared copy in the OS page cache, not a
        // private copy per connection) plus a 64 MB page cache per connection.
        // Measured 2026-10-26 on the 3 GB live index: a deep grid page 125 ms →
        // 48 ms, the status aggregate 360 ms → 150 ms; small indexed queries
        // unchanged. 4 GB is address space, sized above the database file.
        // The file must stay on local disk: a mapped read that hits an I/O
        // error kills the process (SIGBUS) instead of failing the query.
        "mmap_size = 4294967296",
        "cache_size = -65536",
      ],
      customFunctions: [
        { name: "REGEXP", options: { deterministic: true }, type: "regexp" },
        {
          // Similarity over int8 embedding blobs (see embeddingCodec.ts), for
          // queries that compare against a subset of vectors inside SQL.
          name: "cosine_similarity_i8",
          options: { deterministic: true },
          type: "cosine_similarity_i8",
        },
      ],
    });

    // Must precede prepareTables: it moves embeddings into their side tables by
    // reading legacy columns that prepareTables would otherwise have dropped.
    await migrateEmbeddingStorage(this.db);

    // Same ordering constraint: it reads `faceExclusions`, which is no longer in
    // the table definitions, so prepareTables would drop it first.
    await migrateFaceVerdicts(this.db);

    await prepareTables(this.db);

    // Must run on the critical path (before tasks start) so the EXIF task
    // sees the re-queued HEIC files on its first iteration rather than
    // completing with 0 items before this migration fires off-path.
    await this.backfillHeicEmbeddedVideoDetection();
    await this.backfillTags();

    const faceClusterEngine = new FaceClusterEngine(this.db);
    this.faceClusters = new FaceClusterStore(this.db, faceClusterEngine, () =>
      this.invalidateStatusCountsCache(),
    );
    this.faces = new FaceStore(
      this.db,
      faceClusterEngine,
      () => this.invalidateStatusCountsCache(),
      () => this.faceClusters.invalidateFaceClusterPCACache(),
    );
    this.moments = new MomentStore(this.db);

    // Loads in the background (~2 s for 177k vectors); a search issued before
    // it finishes simply waits for it, since the worker handles requests in order.
    this.vectorIndex = new VectorIndex(this.dbFilePath);
    this.analysis = new AnalysisStore(this.db, this.vectorIndex);
    const loadStarted = Date.now();
    void this.vectorIndex.loaded.then(
      (counts) => log.info({ ...counts, ms: Date.now() - loadStarted }, "Vector index loaded"),
      (err: unknown) => log.error({ err }, "Vector index failed to load; semantic search is unavailable"),
    );

    await this.db.get<{ count: number }>("SELECT COUNT(*) as count FROM files");

    // Clean up any leftover zombie WAL from the previous run before starting
    // the periodic maintenance timer.
    await this.checkpointWal();
    this.startWalMaintenance();

    // Everything below is startup *maintenance*, not a precondition for serving
    // requests, so it runs off the critical path: init() resolves as soon as the
    // schema is ready and the HTTP server binds immediately, instead of blocking
    // minutes behind it. None of it affects whether photos load — only People-tab
    // representative ordering, which any request lazily recomputes
    // (getFaceClustersPCA) until the warm lands.
    this.startupMaintenance = (async () => {
      // One-time cleanup of low-confidence "garbage" face clusters that formed
      // before the confidence gate existed. Gated by PRAGMA user_version, so it
      // only runs once; on first run it loads the full centroid set and is the
      // bulk of the old ~2 min startup stall. Runs before the engine loads its
      // centroids, so the fresh lazy-load reflects the post-purge state.
      await this.faceClusters.purgeLowConfidenceFaceClusters();
      // Backfill: bring already-merged persons onto the canonical-centroid scale
      // that merges now maintain. Ordering is significant — runs after the purge
      // (which frees hub survivors) and lazily loads the engine's post-purge
      // centroids on first use.
      await this.faceClusters.rescoreMergedClusterSimilarities();
      // Queue an EXIF re-scan of already-processed images so the new
      // human-authored `description` column gets backfilled from their headers.
      await this.backfillExifDescriptions();
      // Return faces scored by a superseded attribute derivation to the
      // backfill queue. No-op unless FACE_ATTRIBUTE_VERSION moved.
      await this.faces.resetStaleFaceAttributes();
      // Warm the PCA cache from the post-migration state so the first People-tab
      // request is instant.
      await this.faceClusters.warmPCACache();
    })().catch((err) => {
      log.warn({ err }, "Background startup maintenance failed (non-fatal)");
    });
  }

  // Passive autocheckpoints (wal_autocheckpoint) abort whenever a reader holds a
  // snapshot. The dedicated read connection services a near-constant stream of
  // background queries, so passive checkpoints get starved and the WAL grows
  // without bound (observed at ~1 GB). A periodic TRUNCATE checkpoint on the
  // write connection writes committed frames back into the main DB and resets
  // the WAL file during the gaps between readers.
  private startWalMaintenance(): void {
    const intervalMs = Number(process.env.PHOTRIX_WAL_CHECKPOINT_INTERVAL_MS) || 60_000;
    if (intervalMs <= 0) return;
    this.walCheckpointTimer = setInterval(() => {
      void this.checkpointWal();
    }, intervalMs);
    this.walCheckpointTimer.unref?.();
  }

  /**
   * Stop the WAL timer and the worker threads. The server never calls this (it
   * exits instead), but anything else that opens a database must: the SQLite
   * workers are not unref'd, so an unclosed database keeps the process alive
   * after the work is done. A single jest file runs in-process and hangs that way.
   */
  async close(): Promise<void> {
    if (this.walCheckpointTimer) clearInterval(this.walCheckpointTimer);
    this.walCheckpointTimer = undefined;
    // Maintenance still running would fail mid-query once the workers are gone.
    // It never rejects: it logs its own failure.
    await this.startupMaintenance;
    // Fields are unset if init() failed part-way; close whatever got opened.
    await (this.vectorIndex as VectorIndex | undefined)?.close();
    await (this.db as AsyncSqlite | undefined)?.close();
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
        if (result && result.busy === 0) return;
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
    this.invalidateStatusCountsCache();
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

  async fileMatchesFilter(subPath: string, filter: FilterElement): Promise<boolean> {
    const { folder, fileName } = splitPath(subPath);
    const combined: FilterElement = {
      operation: "and",
      conditions: [filter, { folder, fileName }],
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
    const cached = this.statusCountsCache;
    if (cached && Date.now() - cached.at < IndexDatabase.STATUS_COUNTS_TTL_MS) {
      return cached.value;
    }
    if (this.statusCountsInflight) {
      return this.statusCountsInflight;
    }

    // Shared across concurrent callers: don't let the first caller's request
    // abort reject the promise everyone else is awaiting.
    this.statusCountsInflight = runWithoutRequestAbortSignal(() =>
      this.computeStatusCounts(),
    )
      .then((value) => {
        this.statusCountsCache = { value, at: Date.now() };
        return value;
      })
      .finally(() => {
        this.statusCountsInflight = undefined;
      });

    return this.statusCountsInflight;
  }

  /**
   * Drops the memoized status counts so the next read recomputes. Called from
   * writes that change a counted column (file add/remove, exif/variants/face
   * processing stamps); without it a save made inside the 1s TTL window returns
   * a stale count.
   */
  private invalidateStatusCountsCache(): void {
    this.statusCountsCache = undefined;
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
    this.invalidateStatusCountsCache();
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
    this.invalidateStatusCountsCache();
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
    this.faceClusters.invalidateFaceClusterPCACache();
    this.invalidateStatusCountsCache();
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
    this.invalidateStatusCountsCache();
  }

  private async removeFromVectorIndex(folder: string, fileName: string): Promise<void> {
    await this.vectorIndex.remove({ folder, fileName }, ["image", "audio"]);
  }

  async removeFolder(relativePath: string): Promise<void> {
    const base = normalizeFolderPath(relativePath);
    const likePattern = `${escapeLikeLiteral(base)}%`;
    const statements = [
      {
        sql: "DELETE FROM files WHERE folder LIKE ? ESCAPE '\\'",
        params: [likePattern],
      },
      ...deleteFacesStatements("folder LIKE ? ESCAPE '\\'", [likePattern]),
      {
        sql: "DELETE FROM fileEmbeddings WHERE folder LIKE ? ESCAPE '\\'",
        params: [likePattern],
      },
      {
        sql: "DELETE FROM audioSegments WHERE folder LIKE ? ESCAPE '\\'",
        params: [likePattern],
      },
    ];
    await this.db.transaction(statements);
    await this.vectorIndex.removeFolder(base);
    this.invalidateStatusCountsCache();
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
    limit?: number;
  }): Promise<GeoClusterResult> {
    const { filter, clusterSize, bounds, limit = GEO_CLUSTER_LIMIT } = options;
    const { where: whereClause, params: whereParams } = filterToSQL(filter);
    const bucket = Math.max(clusterSize, 0.00000001);
    const latOrigin = Math.floor((bounds?.south ?? 0) / bucket) * bucket;
    const lonOrigin = Math.floor((bounds?.west ?? 0) / bucket) * bucket;

    const rows = await this.db.all<{
      latitude: number;
      longitude: number;
      count: number;
      sampleKey: string | null;
      minDate: number | null;
      maxDate: number | null;
      totalCount: number | null;
    }>(
      // One pass: bucket, aggregate, done. An earlier version added a second
      // ROW_NUMBER() pass over every geotagged row and joined it back just to
      // pick each bucket's sample file; a MIN() over the joined columns picks
      // the same row directly, for half the time on the 191k-row library.
      //
      // The CHAR(1) separator is what makes that substitution exact. Plain
      // `folder || fileName` compares the two as one string, which disagrees
      // with ORDER BY folder, fileName whenever one folder is a prefix of
      // another ("/IMG.JPG" vs "/2014/.../x.jpg"). CHAR(1) sorts below every
      // character that can appear in a path, so the concatenation orders exactly
      // as the column pair did — and since no path contains it, splitting on it
      // recovers folder and fileName unambiguously. They are split here rather
      // than selected as bare columns because SQLite only pins bare columns to
      // the min/max row when the query has exactly one min()/max() aggregate;
      // this one has three.
      //
      // `sortDate` mirrors the library's default ordering (dateTaken, falling
      // back to created/modified). The typeof(...) = 'integer' guards keep rows
      // whose date was ingested as a TEXT/ISO string out of MIN/MAX — SQLite
      // sorts TEXT above every INTEGER, so one stray string poisons the max
      // (same hazard getDateRange guards against).
      //
      // totalCount is a window function, so it sums every bucket's count before
      // LIMIT trims the result — that is what lets the caller tell a complete
      // answer from a truncated one.
      `SELECT
         (latBucket + 0.5) * ? + ? AS latitude,
         (lonBucket + 0.5) * ? + ? AS longitude,
         count,
         minDate,
         maxDate,
         sampleKey,
         SUM(count) OVER () AS totalCount
       FROM (
         SELECT
           CAST(FLOOR((locationLatitude - ?) / ?) AS INTEGER) AS latBucket,
           CAST(FLOOR((locationLongitude - ?) / ?) AS INTEGER) AS lonBucket,
           COUNT(*) AS count,
           MIN(CASE
             WHEN typeof(dateTaken) = 'integer' THEN dateTaken
             WHEN typeof(created) = 'integer' THEN created
             WHEN typeof(modified) = 'integer' THEN modified
           END) AS minDate,
           MAX(CASE
             WHEN typeof(dateTaken) = 'integer' THEN dateTaken
             WHEN typeof(created) = 'integer' THEN created
             WHEN typeof(modified) = 'integer' THEN modified
           END) AS maxDate,
           MIN(folder || CHAR(1) || fileName) AS sampleKey
         FROM files
         WHERE locationLatitude IS NOT NULL
           AND locationLongitude IS NOT NULL
           ${whereClause ? `AND ${whereClause}` : ""}
         GROUP BY latBucket, lonBucket
       )
       ORDER BY count DESC
       LIMIT ?`,
      bucket,
      latOrigin,
      bucket,
      lonOrigin,
      latOrigin,
      bucket,
      lonOrigin,
      bucket,
      ...whereParams,
      limit,
    );

    // Every row carries the same window-function total; with no rows there is
    // nothing to count.
    const total = rows[0]?.totalCount ?? 0;

    return {
      clusters: rows.map(({ totalCount: _totalCount, sampleKey, ...row }) => {
        const separator = sampleKey?.indexOf(SAMPLE_KEY_SEPARATOR) ?? -1;
        return {
          ...row,
          samplePath:
            separator === -1 ? null : sampleKey!.replace(SAMPLE_KEY_SEPARATOR, ""),
          sampleName: separator === -1 ? null : sampleKey!.slice(separator + 1),
        };
      }),
      total,
    };
  }

  /**
   * One-time migration (gated by PRAGMA user_version) that re-queues images for
   * EXIF extraction so the newly-added human-authored `description` column is
   * backfilled from their file headers. Images scanned before the column existed
   * carry a non-null exifProcessedAt, so processExifMetadata would otherwise skip
   * them forever. Clearing exifProcessedAt (only for already-processed images)
   * puts them back on the "needs EXIF" queue; the re-read is header-only and the
   * extraction is idempotent for every other field. New files are unaffected.
   */
  private async backfillExifDescriptions(): Promise<void> {
    const versionRow = await this.db.get<{ user_version: number }>(
      "PRAGMA user_version",
    );
    if ((versionRow?.user_version ?? 0) >= EXIF_DESCRIPTION_BACKFILL_VERSION) return;

    const result = await this.db.run(
      `UPDATE files SET exifProcessedAt = NULL
       WHERE exifProcessedAt IS NOT NULL
         AND mimeType LIKE 'image/%'
         AND description IS NULL`,
    );

    await this.db.exec(`PRAGMA user_version = ${EXIF_DESCRIPTION_BACKFILL_VERSION}`);
    this.invalidateStatusCountsCache();
    log.info(
      { requeued: result?.changes ?? 0 },
      "Re-queued images for EXIF re-scan to backfill human descriptions",
    );
  }

  /**
   * One-time migration (gated by PRAGMA user_version) that re-queues every
   * already-processed image for EXIF re-scan so the `tags` column (see
   * TAGS_BACKFILL_VERSION above) gets backfilled from XMP dc:subject / IPTC
   * Keywords / lr:hierarchicalSubject. Scoped to `tags IS NULL` so it never
   * re-queues (and thus never clobbers) a file whose tags were already
   * extracted or user-edited in-app.
   */
  private async backfillTags(): Promise<void> {
    const versionRow = await this.db.get<{ user_version: number }>(
      "PRAGMA user_version",
    );
    if ((versionRow?.user_version ?? 0) >= TAGS_BACKFILL_VERSION) return;

    const result = await this.db.run(
      `UPDATE files SET exifProcessedAt = NULL
       WHERE exifProcessedAt IS NOT NULL
         AND mimeType LIKE 'image/%'
         AND tags IS NULL`,
    );

    await this.db.exec(`PRAGMA user_version = ${TAGS_BACKFILL_VERSION}`);
    this.invalidateStatusCountsCache();
    log.info(
      { requeued: result?.changes ?? 0 },
      "Re-queued images for EXIF re-scan to backfill human-authored tags/keywords",
    );
  }

  private async backfillHeicEmbeddedVideoDetection(): Promise<void> {
    const versionRow = await this.db.get<{ user_version: number }>(
      "PRAGMA user_version",
    );
    if ((versionRow?.user_version ?? 0) >= HEIC_EMBEDDED_VIDEO_BACKFILL_VERSION) return;

    const result = await this.db.run(
      `UPDATE files SET exifProcessedAt = NULL
       WHERE exifProcessedAt IS NOT NULL
         AND mimeType IN ('image/heic', 'image/heif')`,
    );

    await this.db.exec(`PRAGMA user_version = ${HEIC_EMBEDDED_VIDEO_BACKFILL_VERSION}`);
    this.invalidateStatusCountsCache();
    log.info(
      { requeued: result?.changes ?? 0 },
      "Re-queued HEIC/HEIF files for EXIF re-scan to detect embedded Samsung motion photos",
    );
  }

  /**
   * The user's standing "hide these by default" filter (feedback #95) —
   * e.g. a specific face cluster or folder they want excluded from the main
   * gallery/grid/map/people views unless explicitly overridden per-request.
   * Cached in memory (see `defaultExclusionFilterCache`) so the common path
   * — every /api/files request — costs no DB round trip; only
   * `setDefaultExclusionFilter` invalidates it.
   */
  async getDefaultExclusionFilter(): Promise<QueryOptions["filter"] | null> {
    if (this.defaultExclusionFilterCache !== undefined) {
      return this.defaultExclusionFilterCache;
    }
    const row = await this.db.get<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'defaultExclusionFilter'",
    );
    let parsed: QueryOptions["filter"] | null = null;
    if (row?.value) {
      try {
        parsed = JSON.parse(row.value) as QueryOptions["filter"];
      } catch {
        parsed = null;
      }
    }
    this.defaultExclusionFilterCache = parsed;
    return parsed;
  }

  /** Sets (or, with `null`, clears) the default exclusion filter and drops the cache. */
  async setDefaultExclusionFilter(filter: QueryOptions["filter"] | null): Promise<void> {
    if (filter === null) {
      await this.db.run("DELETE FROM settings WHERE key = 'defaultExclusionFilter'");
    } else {
      await this.db.run(
        "INSERT INTO settings (key, value) VALUES ('defaultExclusionFilter', ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        JSON.stringify(filter),
      );
    }
    this.defaultExclusionFilterCache = filter;
  }

  /** Settles once the in-memory vector index has loaded (or failed to). */
  get vectorIndexLoaded(): Promise<unknown> {
    return this.vectorIndex.loaded;
  }

  async queryFiles<TMetadata extends Array<keyof FileRecord>>(
    options: QueryOptions,
  ): Promise<QueryResult<TMetadata>> {
    const {
      filter,
      metadata,
      pageSize = 1_000,
      page: rawPage = 1,
      expandToFolder,
      sort,
      collapseMomentClusters = true,
    } = options;
    const page = Math.max(1, rawPage);

    const { where: whereClause, params: whereParams } = filterToSQL(filter);

    // When expandToFolder is enabled, wrap the filter in a folder-IN-subquery so
    // all files in a matched folder are returned, not just the matched files.
    const folderExpandedWhere =
      expandToFolder && whereClause
        ? `folder IN (SELECT DISTINCT folder FROM files WHERE ${whereClause})`
        : whereClause;

    // Default gallery behavior: a moment cluster (burst/near-duplicate group)
    // collapses to just its representative row. Files with no cluster
    // (momentClusterId IS NULL) are unaffected. Callers expanding a stack (or
    // fetching a specific cluster's members) pass collapseMomentClusters: false.
    const effectiveWhere = collapseMomentClusters
      ? [
          folderExpandedWhere,
          "(momentClusterId IS NULL OR momentClusterRepresentative = 1)",
        ]
          .filter(Boolean)
          .join(" AND ")
      : folderExpandedWhere;

    const countSQL = `SELECT COUNT(*) as count FROM files ${effectiveWhere ? `WHERE ${effectiveWhere}` : ""}`;
    const countResult = await (() =>
      this.db.get<{ count: number }>(countSQL, ...whereParams))();
    const total = countResult?.count ?? 0;

    // The stack badge needs a member count alongside the representative row;
    // only joined in when asked for, so the common case (no metadata request
    // for it) pays nothing extra.
    const extraColumns: string[] = [];
    if (metadata?.includes("momentClusterSize")) {
      extraColumns.push(`(CASE WHEN files.momentClusterId IS NULL THEN NULL ELSE
             (SELECT COUNT(*) FROM files momentMember WHERE momentMember.momentClusterId = files.momentClusterId)
           END) AS momentClusterSize`);
    }
    // A handful of the *other* members' paths (representative excluded), so
    // the collapsed tile can render a couple of real thumbnails peeking out
    // behind the representative — a genuine "stack of photos" look — instead
    // of an abstract count badge alone. Same opt-in shape as
    // momentClusterSize (a correlated subquery, not a per-tile extra round
    // trip, since a gallery page can show many stacks at once), and same
    // "no signal for a non-clustered row" NULL convention. Capped at 2 and
    // ranked by the same quality signal the representative pick itself uses
    // (see momentClusterEngine.pickRepresentative) — the peeking photos are
    // realistically the ones a user would pick, not arbitrary members.
    // json_group_array over a LIMIT'd derived table (rather than a bare
    // GROUP_CONCAT) sidesteps any need to worry about a folder/fileName
    // containing whatever separator character a naive string join would pick.
    if (metadata?.includes("momentClusterPreviewPaths")) {
      extraColumns.push(`(CASE WHEN files.momentClusterId IS NULL THEN NULL ELSE
             (SELECT json_group_array(preview.path) FROM (
               SELECT (other.folder || other.fileName) AS path
               FROM files AS other
               WHERE other.momentClusterId = files.momentClusterId
                 AND NOT (other.folder = files.folder AND other.fileName = files.fileName)
               ORDER BY COALESCE(other.photoQualityScore, 0) DESC, COALESCE(other.sharpnessScore, 0) DESC
               LIMIT 2
             ) AS preview)
           END) AS momentClusterPreviewPaths`);
    }
    const columns =
      extraColumns.length > 0 ? `${FILE_QUERY_COLUMNS}, ${extraColumns.join(", ")}` : FILE_QUERY_COLUMNS;

    const offset = (page - 1) * pageSize;
    const mainSQL = `
      SELECT ${columns} FROM files
      ${effectiveWhere ? `WHERE ${effectiveWhere}` : ""}
      ORDER BY ${buildQueryOrderBy(sort)}
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
