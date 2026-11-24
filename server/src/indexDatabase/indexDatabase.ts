import type { AsyncSqlite } from "../common/asyncSqlite.ts";
import type { IndexSqlite } from "./openIndexSqlite.ts";
import { WriteInvalidatedCache } from "../common/writeInvalidatedCache.ts";
import type { FileRecord } from "./fileRecord.type.ts";
import type { QueryOptions, QueryResult } from "./indexDatabase.type.ts";
import { prepareTables } from "./prepareTables.ts";
import { migrateEmbeddingStorage } from "./migrateEmbeddingStorage.ts";
import { VectorIndex } from "./vectorIndex/vectorIndex.ts";
import { FaceStore } from "../people/store/faceStore.ts";
import { FaceClusterStore } from "../people/store/faceClusterStore.ts";
import { MomentStore } from "./momentStore.ts";
import { PlaceStore } from "./placeStore.ts";
import { AnalysisStore } from "./analysisStore.ts";
import { FaceClusterEngine } from "../people/store/faceClusterEngine.ts";
import { migrateFaceVerdicts } from "../people/store/migrateFaceVerdicts.ts";
import { getLogger } from "../observability/logger.ts";
import { ExifBackfills } from "./exifBackfills.ts";
import { FileQueryStore } from "./fileQueryStore.ts";
import { FileStore } from "./fileStore.ts";
import { GeoStore } from "./geoStore.ts";
import { MaintenanceStore } from "./maintenanceStore.ts";
import { StatsStore } from "./statsStore.ts";
import { SuggestionStore } from "./suggestionStore.ts";
import { TaskQueueStore } from "./taskQueueStore.ts";

const log = getLogger("IndexDatabase");

/**
 * The index database: one SQLite file behind a facade over focused stores.
 * Each query lives in the store that owns its table or concern (see
 * indexDatabase/README.md); the methods below only delegate, so callers keep
 * writing `database.addFile(...)`. The stores are public for callers that want
 * the namespaced form, as `faces`, `faceClusters`, `moments`, `places` and
 * `analysis` always have been.
 */
export class IndexDatabase {
  public readonly storagePath: string;
  private readonly db: AsyncSqlite;
  private readonly dbFilePath: string;
  // In-memory copy of every CLIP/CLAP vector, so semantic search is one pass
  // over packed memory instead of a full-table SQL scan. Every write to
  // `fileEmbeddings` is mirrored into it after the write commits.
  private vectorIndex!: VectorIndex;
  // Off-critical-path startup work kicked off by init() (one-time face-cluster
  // migrations + PCA warm). init() resolves without awaiting it so the HTTP
  // server binds immediately; tests can await this to observe the settled state.
  startupMaintenance: Promise<void> = Promise.resolve();
  // Small aggregates over the whole filtered library, kept until the next
  // write: the grid's total, folder lists, the date histogram and date range.
  // The grid asks for the same total with every page it loads, and counting is
  // the expensive half of that query (a pass over every file, against an
  // index-ordered read of 200). Cached results are shared: read-only.
  private aggregateCache!: WriteInvalidatedCache;
  private exifBackfills!: ExifBackfills;
  files!: FileStore;
  fileQueries!: FileQueryStore;
  stats!: StatsStore;
  suggestions!: SuggestionStore;
  geo!: GeoStore;
  tasks!: TaskQueueStore;
  maintenance!: MaintenanceStore;
  // Incremental face clustering: assignments are persisted on the faces rows
  // and centroids in the faceClusters table, so People queries are plain
  // indexed reads. See people/store/faceClusterEngine.ts.
  faces!: FaceStore;
  faceClusters!: FaceClusterStore;
  moments!: MomentStore;
  places!: PlaceStore;
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

  /** Takes over the connection: `init()` creates its tables and `close()` closes it. */
  constructor(storagePath: string, { sqlite, filePath }: IndexSqlite) {
    this.storagePath = storagePath;
    this.db = sqlite;
    this.dbFilePath = filePath;
  }

  /** Set once the SQLite worker has died; every query fails from then on. */
  get failed(): Error | null {
    return this.db.failed;
  }

  /** Can't be part of constructor because it's async */
  async init(): Promise<void> {
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
    this.aggregateCache = new WriteInvalidatedCache(() => this.db.writeGeneration, 256);
    this.stats = new StatsStore(this.db, this.aggregateCache);
    this.exifBackfills = new ExifBackfills(this.db, () =>
      this.stats.invalidateStatusCountsCache(),
    );
    await this.exifBackfills.backfillHeicEmbeddedVideoDetection();
    await this.exifBackfills.backfillTags();

    const faceClusterEngine = new FaceClusterEngine(this.db);
    this.faceClusters = new FaceClusterStore(this.db, faceClusterEngine, () =>
      this.stats.invalidateStatusCountsCache(),
    );
    this.faces = new FaceStore(
      this.db,
      faceClusterEngine,
      () => this.stats.invalidateStatusCountsCache(),
      () => this.faceClusters.invalidateFaceClusterPCACache(),
    );
    this.moments = new MomentStore(this.db);
    this.places = new PlaceStore(this.db);

    // Loads in the background (~2 s for 177k vectors); a search issued before
    // it finishes simply waits for it, since the worker handles requests in order.
    this.vectorIndex = new VectorIndex(this.dbFilePath);
    this.analysis = new AnalysisStore(this.db, this.vectorIndex);
    this.files = new FileStore(
      this.db,
      this.vectorIndex,
      () => this.stats.invalidateStatusCountsCache(),
      () => this.faceClusters.invalidateFaceClusterPCACache(),
    );
    this.fileQueries = new FileQueryStore(this.db, this.aggregateCache);
    this.suggestions = new SuggestionStore(this.db);
    this.geo = new GeoStore(this.db);
    this.tasks = new TaskQueueStore(this.db);
    this.maintenance = new MaintenanceStore(this.db, this.dbFilePath);
    const loadStarted = Date.now();
    void this.vectorIndex.loaded.then(
      (counts) => log.info({ ...counts, ms: Date.now() - loadStarted }, "Vector index loaded"),
      (err: unknown) => log.error({ err }, "Vector index failed to load; semantic search is unavailable"),
    );

    await this.db.get<{ count: number }>("SELECT COUNT(*) as count FROM files");

    // Clean up any leftover zombie WAL from the previous run before starting
    // the periodic maintenance timer.
    await this.maintenance.checkpointWal();
    this.maintenance.startWalMaintenance();

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
      await this.exifBackfills.backfillExifDescriptions();
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


  /**
   * Stop the WAL timer and the worker threads. The server never calls this (it
   * exits instead), but anything else that opens a database must: the SQLite
   * workers are not unref'd, so an unclosed database keeps the process alive
   * after the work is done. A single jest file runs in-process and hangs that way.
   */
  async close(): Promise<void> {
    this.maintenance?.stopWalMaintenance();
    // Maintenance still running would fail mid-query once the workers are gone.
    // It never rejects: it logs its own failure.
    await this.startupMaintenance;
    // Fields are unset if init() failed part-way; close whatever got opened.
    await (this.vectorIndex as VectorIndex | undefined)?.close();
    await this.db.close();
  }
  /** Settles once the in-memory vector index has loaded (or failed to). */
  get vectorIndexLoaded(): Promise<unknown> {
    return this.vectorIndex.loaded;
  }

  async queryFiles<TMetadata extends Array<keyof FileRecord>>(
    options: QueryOptions,
  ): Promise<QueryResult<TMetadata>> {
    return this.fileQueries.queryFiles<TMetadata>(options);
  }

  // --- files: see fileStore.ts
  addFile(...args: Parameters<FileStore["addFile"]>) {
    return this.files.addFile(...args);
  }
  moveFile(...args: Parameters<FileStore["moveFile"]>) {
    return this.files.moveFile(...args);
  }
  addOrUpdateFileData(...args: Parameters<FileStore["addOrUpdateFileData"]>) {
    return this.files.addOrUpdateFileData(...args);
  }
  setAiDescription(...args: Parameters<FileStore["setAiDescription"]>) {
    return this.files.setAiDescription(...args);
  }
  updateUserMetadata(...args: Parameters<FileStore["updateUserMetadata"]>) {
    return this.files.updateUserMetadata(...args);
  }
  getFilesPendingMetadataWriteback(...args: Parameters<FileStore["getFilesPendingMetadataWriteback"]>) {
    return this.files.getFilesPendingMetadataWriteback(...args);
  }
  clearMetadataWriteback(...args: Parameters<FileStore["clearMetadataWriteback"]>) {
    return this.files.clearMetadataWriteback(...args);
  }
  getFileRecord(...args: Parameters<FileStore["getFileRecord"]>) {
    return this.files.getFileRecord(...args);
  }
  addPaths(...args: Parameters<FileStore["addPaths"]>) {
    return this.files.addPaths(...args);
  }
  removeFile(...args: Parameters<FileStore["removeFile"]>) {
    return this.files.removeFile(...args);
  }
  markFileForResync(...args: Parameters<FileStore["markFileForResync"]>) {
    return this.files.markFileForResync(...args);
  }
  removePaths(...args: Parameters<FileStore["removePaths"]>) {
    return this.files.removePaths(...args);
  }
  removeFolder(...args: Parameters<FileStore["removeFolder"]>) {
    return this.files.removeFolder(...args);
  }
  getIndexedPaths(...args: Parameters<FileStore["getIndexedPaths"]>) {
    return this.files.getIndexedPaths(...args);
  }
  markImageVariantsGenerated(...args: Parameters<FileStore["markImageVariantsGenerated"]>) {
    return this.files.markImageVariantsGenerated(...args);
  }
  markHLSGenerated(...args: Parameters<FileStore["markHLSGenerated"]>) {
    return this.files.markHLSGenerated(...args);
  }
  // --- stats: see statsStore.ts
  countMissingInfo(...args: Parameters<StatsStore["countMissingInfo"]>) {
    return this.stats.countMissingInfo(...args);
  }
  countMissingDateTaken(...args: Parameters<StatsStore["countMissingDateTaken"]>) {
    return this.stats.countMissingDateTaken(...args);
  }
  countMediaEntries(...args: Parameters<StatsStore["countMediaEntries"]>) {
    return this.stats.countMediaEntries(...args);
  }
  countImageEntries(...args: Parameters<StatsStore["countImageEntries"]>) {
    return this.stats.countImageEntries(...args);
  }
  countAllEntries(...args: Parameters<StatsStore["countAllEntries"]>) {
    return this.stats.countAllEntries(...args);
  }
  getStatusCounts(...args: Parameters<StatsStore["getStatusCounts"]>) {
    return this.stats.getStatusCounts(...args);
  }
  getMostRecentExifProcessedEntry(...args: Parameters<StatsStore["getMostRecentExifProcessedEntry"]>) {
    return this.stats.getMostRecentExifProcessedEntry(...args);
  }
  getRatingStats(...args: Parameters<StatsStore["getRatingStats"]>) {
    return this.stats.getRatingStats(...args);
  }
  getSize(...args: Parameters<StatsStore["getSize"]>) {
    return this.stats.getSize(...args);
  }
  getFolders(...args: Parameters<StatsStore["getFolders"]>) {
    return this.stats.getFolders(...args);
  }
  getDateRange(...args: Parameters<StatsStore["getDateRange"]>) {
    return this.stats.getDateRange(...args);
  }
  getDateHistogram(...args: Parameters<StatsStore["getDateHistogram"]>) {
    return this.stats.getDateHistogram(...args);
  }
  // --- fileQueries: see fileQueryStore.ts
  fileMatchesFilter(...args: Parameters<FileQueryStore["fileMatchesFilter"]>) {
    return this.fileQueries.fileMatchesFilter(...args);
  }
  // --- suggestions: see suggestionStore.ts
  queryFieldSuggestions(...args: Parameters<SuggestionStore["queryFieldSuggestions"]>) {
    return this.suggestions.queryFieldSuggestions(...args);
  }
  queryFieldSuggestionsWithCounts(...args: Parameters<SuggestionStore["queryFieldSuggestionsWithCounts"]>) {
    return this.suggestions.queryFieldSuggestionsWithCounts(...args);
  }
  // --- geo: see geoStore.ts
  queryGeoClusters(...args: Parameters<GeoStore["queryGeoClusters"]>) {
    return this.geo.queryGeoClusters(...args);
  }
  // --- tasks: see taskQueueStore.ts
  countFilesNeedingMetadataUpdate(...args: Parameters<TaskQueueStore["countFilesNeedingMetadataUpdate"]>) {
    return this.tasks.countFilesNeedingMetadataUpdate(...args);
  }
  getFilesNeedingMetadataUpdate(...args: Parameters<TaskQueueStore["getFilesNeedingMetadataUpdate"]>) {
    return this.tasks.getFilesNeedingMetadataUpdate(...args);
  }
  getImagesMissingDimensions(...args: Parameters<TaskQueueStore["getImagesMissingDimensions"]>) {
    return this.tasks.getImagesMissingDimensions(...args);
  }
  getThumbnailBackfillCandidates(...args: Parameters<TaskQueueStore["getThumbnailBackfillCandidates"]>) {
    return this.tasks.getThumbnailBackfillCandidates(...args);
  }
  getNextBackgroundTask(...args: Parameters<TaskQueueStore["getNextBackgroundTask"]>) {
    return this.tasks.getNextBackgroundTask(...args);
  }
  // --- maintenance: see maintenanceStore.ts
  checkpointWal(...args: Parameters<MaintenanceStore["checkpointWal"]>) {
    return this.maintenance.checkpointWal(...args);
  }
  optimize(...args: Parameters<MaintenanceStore["optimize"]>) {
    return this.maintenance.optimize(...args);
  }
  getOnDiskSize(...args: Parameters<MaintenanceStore["getOnDiskSize"]>) {
    return this.maintenance.getOnDiskSize(...args);
  }
  getDefaultExclusionFilter(...args: Parameters<MaintenanceStore["getDefaultExclusionFilter"]>) {
    return this.maintenance.getDefaultExclusionFilter(...args);
  }
  setDefaultExclusionFilter(...args: Parameters<MaintenanceStore["setDefaultExclusionFilter"]>) {
    return this.maintenance.setDefaultExclusionFilter(...args);
  }
}
