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
  type MomentClusterDetail,
  type QueryOptions,
  type QueryResult,
  type SortOption,
} from "./indexDatabase.type.ts";
import { pickRepresentative } from "./momentClusterEngine.ts";
import {
  fileRecordToColumnNamesAndValues,
  rowToFileRecord,
} from "./rowFileRecordConversionFunctions.ts";
import { joinPath, normalizeFolderPath, splitPath } from "./utils/pathUtils.ts";
import { escapeLikeLiteral } from "./utils/sqlUtils.ts";
import { prepareTables } from "./prepareTables.ts";
import { migrateEmbeddingStorage } from "./migrateEmbeddingStorage.ts";
import { decodeEmbedding, encodeEmbedding } from "./embeddingCodec.ts";
import {
  FaceClusterEngine,
  LOW_CONFIDENCE_CLUSTER_ID,
  MIN_FACE_CONFIDENCE_FOR_CLUSTERING,
  UNCLUSTERABLE_CLUSTER_ID,
  toAlignedFloat32,
} from "./faceClusterEngine.ts";
import { tables } from "./tables.ts";
import { computePCA3D } from "./pca.ts";
import { getLogger } from "../observability/logger.ts";
import { FACE_ATTRIBUTE_VERSION } from "../faceDetection/faceAttributes.ts";
import type { FaceAttributes } from "../faceDetection/faceDetector.type.ts";
import {
  computePhotoQualityScore,
  faceAttributesToQualityInputs,
  type FaceQualityInputs,
} from "../faceDetection/photoQuality.ts";

const log = getLogger("IndexDatabase");

// PRAGMA user_version marking that the one-time low-confidence face-cluster
// purge has run (see purgeLowConfidenceFaceClusters). Bump to re-run after a
// future change to the confidence floor.
const LOW_CONFIDENCE_PURGE_VERSION = 1;

// PRAGMA user_version marking that the one-time rescore of already-merged
// sub-clusters against their canonical centroid has run (see
// rescoreMergedClusterSimilarities). Runs after the purge, so it must sit above
// LOW_CONFIDENCE_PURGE_VERSION in this monotonically-increasing scheme.
const MERGED_SIMILARITY_RESCORE_VERSION = 2;

// PRAGMA user_version marking that the one-time EXIF re-extraction pass for the
// new human-authored `description` column has been queued. Bumps the monotonic
// scheme above MERGED_SIMILARITY_RESCORE_VERSION. Clears exifProcessedAt on
// already-processed images so processExifMetadata re-reads their headers and
// fills in `description` (and any other fields added since they were scanned).
const EXIF_DESCRIPTION_BACKFILL_VERSION = 3;

// PRAGMA user_version marking that stale per-face "photo ready" attributes have
// been reset for re-derivation at FACE_ATTRIBUTE_VERSION (see
// resetStaleFaceAttributes). Bump *both* this and FACE_ATTRIBUTE_VERSION when
// the derivation in python/face_attributes.py changes in a way that should
// invalidate existing scores.
const FACE_ATTRIBUTE_RESET_VERSION = 4;

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

// A cluster losing at least this fraction of its members to the confidence
// purge is treated as a junk hub: its confident survivors are freed for
// re-clustering rather than left behind under a junk-derived centroid.
const HUB_RECLUSTER_PURGE_FRACTION = 0.3;

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
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const tokenizeTranscriptSearchText = (value: string): string[] => [
  ...new Set(normalizeTranscriptSearchText(value).split(" ").filter(Boolean)),
];

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

  const termOccurrences = terms.map((term) =>
    countWholeWordOccurrences(normalizedTranscript, term),
  );
  const matchedTerms = termOccurrences.filter((count) => count > 0).length;
  if (matchedTerms === 0) return 0;
  if (terms.length > 1 && matchedTerms < terms.length) return 0;

  const phraseOccurrences = countWholeWordOccurrences(
    normalizedTranscript,
    normalizedQuery,
  );
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

/** Parses a `faceClusters.tags` JSON-array column; NULL/malformed -> []. */
const parsePersonTags = (raw: string | null): string[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
};
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
  faceId: row.id,
});

const formatYearRangeLabel = (
  minDate: number | null,
  maxDate: number | null,
): string | null => {
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
  get asyncSqlite(): AsyncSqlite {
    return this.db;
  }
  private dbFilePath!: string;
  private walCheckpointTimer?: ReturnType<typeof setInterval>;
  // The post-checkpoint semantic warm-scan reads every image embedding (hundreds
  // of MB) to keep the page cache hot. During active ingestion a checkpoint
  // writes back frames roughly every interval, so left unthrottled this heavy
  // scan runs on a read worker every ~60s, competing with user queries and
  // holding a WAL snapshot that blocks the next TRUNCATE. Rate-limit it.
  private lastSemanticWarmAt = 0;
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
  private pcaCache: FaceClusterPCAResult | null = null;
  private pcaCacheInflight: Promise<FaceClusterPCAResult> | null = null;
  // Off-critical-path startup work kicked off by init() (one-time face-cluster
  // migrations + PCA warm). init() resolves without awaiting it so the HTTP
  // server binds immediately; tests can await this to observe the settled state.
  startupMaintenance: Promise<void> = Promise.resolve();
  private seedsCache: FaceClusterPCASeed[] | null = null;
  private seedsCacheInflight: Promise<FaceClusterPCASeed[]> | null = null;
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
  private faceClusters!: FaceClusterEngine;
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
        {
          // Current storage form for every embedding: int8 with a scale header
          // (see embeddingCodec.ts). Pure integer arithmetic, over blobs a
          // quarter the size of the Float32 ones the f32 variant reads.
          name: "cosine_similarity_i8",
          options: { deterministic: true },
          type: "cosine_similarity_i8",
        },
      ],
    });

    // Must precede prepareTables: it moves embeddings into their side tables by
    // reading legacy columns that prepareTables would otherwise have dropped.
    await migrateEmbeddingStorage(this.db);

    await prepareTables(this.db);

    // Must run on the critical path (before tasks start) so the EXIF task
    // sees the re-queued HEIC files on its first iteration rather than
    // completing with 0 items before this migration fires off-path.
    await this.backfillHeicEmbeddedVideoDetection();
    await this.backfillTags();

    this.faceClusters = new FaceClusterEngine(this.db);

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
      await this.purgeLowConfidenceFaceClusters();
      // Backfill: bring already-merged persons onto the canonical-centroid scale
      // that merges now maintain. Ordering is significant — runs after the purge
      // (which frees hub survivors) and lazily loads the engine's post-purge
      // centroids on first use.
      await this.rescoreMergedClusterSimilarities();
      // Queue an EXIF re-scan of already-processed images so the new
      // human-authored `description` column gets backfilled from their headers.
      await this.backfillExifDescriptions();
      // Return faces scored by a superseded attribute derivation to the
      // backfill queue. No-op unless FACE_ATTRIBUTE_VERSION moved.
      await this.resetStaleFaceAttributes();
      // Warm the PCA cache from the post-migration state so the first People-tab
      // request is instant.
      this.pcaCache = await this.computePCACache();
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
          // embeddings. Re-warm the scan cache so those new pages stay hot and
          // the next search doesn't hit a cold page-cache miss — but rate-limited,
          // since during a long ingestion nearly every checkpoint writes frames
          // and the warm scan itself is a full-table embedding read.
          if (result.checkpointed > 0) {
            const warmIntervalMs =
              Number(process.env.PHOTRIX_SEMANTIC_WARM_INTERVAL_MS) || 600_000;
            const nowMs = Date.now();
            if (nowMs - this.lastSemanticWarmAt >= warmIntervalMs) {
              this.lastSemanticWarmAt = nowMs;
              void this.warmSemanticSearch().catch(() => {});
            }
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
      let tags: string[] = [];
      if (row.tags) {
        try {
          const parsed: unknown = JSON.parse(row.tags);
          if (Array.isArray(parsed)) {
            tags = parsed.filter((t): t is string => typeof t === "string");
          }
        } catch {
          // Corrupt/legacy value — treat as no tags.
        }
      }
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
        // Must precede the face delete — it resolves the outgoing face ids
        // through the rows it is about to remove.
        sql: `DELETE FROM faceEmbeddings WHERE faceId IN (
                SELECT id FROM faces WHERE folder = ? AND fileName = ?)`,
        params: [folder, fileName],
      },
      {
        sql: "DELETE FROM faces WHERE folder = ? AND fileName = ?",
        params: [folder, fileName],
      },
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
                 smileScore, eyesOpenScore, focusScore, exposureScore, faceAttrVersion)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      const embeddingStatements: Array<{ sql: string; params: unknown[] }> = [];
      faces.forEach((face, index) => {
        const encoded = encodeEmbedding(face.embedding);
        if (encoded) {
          embeddingStatements.push({
            sql: "INSERT INTO faceEmbeddings (faceId, embedding) VALUES (?, ?)",
            params: [insertedIds[index].id, encoded],
          });
        } else {
          // No usable vector: stamp the sentinel so the clustering backfill
          // (which now selects purely on `clusterId IS NULL`) skips it forever.
          embeddingStatements.push({
            sql: "UPDATE faces SET clusterId = ? WHERE id = ?",
            params: [UNCLUSTERABLE_CLUSTER_ID, insertedIds[index].id],
          });
        }
      });
      if (embeddingStatements.length > 0) {
        await this.db.transaction(embeddingStatements);
      }
    } else {
      log.warn(
        { path: relativePath, inserted: insertedIds.length, expected: faces.length },
        "Face row count did not match detection count; skipping embedding write",
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
      {
        // Before the faces delete — it resolves ids through those rows.
        sql: `DELETE FROM faceEmbeddings WHERE faceId IN (
                SELECT id FROM faces WHERE folder = ? AND fileName = ?)`,
        params: [folder, fileName],
      },
      {
        sql: "DELETE FROM faces WHERE folder = ? AND fileName = ?",
        params: [folder, fileName],
      },
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
      box: { x: number; y: number; width: number; height: number };
      personId: string;
      name: string | null;
    }>
  > {
    const { folder, fileName } = splitPath(relativePath);
    const rows = await this.db.all<{
      boxX: number;
      boxY: number;
      boxWidth: number;
      boxHeight: number;
      personId: number;
      name: string | null;
    }>(
      `SELECT
         faces.boxX,
         faces.boxY,
         faces.boxWidth,
         faces.boxHeight,
         COALESCE(cluster.personId, faces.clusterId) AS personId,
         person.name AS name
       FROM faces
       LEFT JOIN faceClusters AS cluster ON cluster.id = faces.clusterId
       LEFT JOIN faceClusters AS person
         ON person.id = COALESCE(cluster.personId, faces.clusterId)
       WHERE faces.folder = ? AND faces.fileName = ? AND faces.clusterId > 0
       ORDER BY faces.id`,
      folder,
      fileName,
    );

    return rows.map((row) => ({
      box: {
        x: row.boxX,
        y: row.boxY,
        width: row.boxWidth,
        height: row.boxHeight,
      },
      personId: faceClusterIdToString(row.personId),
      name: row.name,
    }));
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
    // Before the faces delete — it resolves ids through the rows it removes.
    await this.db.run(
      `DELETE FROM faceEmbeddings WHERE faceId IN (
         SELECT id FROM faces WHERE folder = ? AND fileName = ?)`,
      [folder, fileName],
    );
    await this.db.run("DELETE FROM faces WHERE folder = ? AND fileName = ?", [
      folder,
      fileName,
    ]);
    await this.db.run("DELETE FROM fileEmbeddings WHERE folder = ? AND fileName = ?", [
      folder,
      fileName,
    ]);
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
    await this.db.run(
      `DELETE FROM faceEmbeddings WHERE faceId IN (
         SELECT id FROM faces WHERE folder = ? AND fileName = ?)`,
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
    this.invalidateFaceClusterPCACache();
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
        {
          // Before the faces delete — it resolves ids through those rows.
          sql: `DELETE FROM faceEmbeddings WHERE faceId IN (
                  SELECT id FROM faces WHERE folder = ? AND fileName = ?)`,
          params: [folder, fileName] as unknown[],
        },
        {
          sql: "DELETE FROM faces WHERE folder = ? AND fileName = ?",
          params: [folder, fileName] as unknown[],
        },
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
    this.invalidateStatusCountsCache();
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
        // Before the faces delete — it resolves ids through those rows.
        sql: `DELETE FROM faceEmbeddings WHERE faceId IN (
                SELECT id FROM faces WHERE folder LIKE ? ESCAPE '\\')`,
        params: [likePattern],
      },
      {
        sql: "DELETE FROM faces WHERE folder LIKE ? ESCAPE '\\'",
        params: [likePattern],
      },
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
    // With no filter (the People tab's default) this is a pure scan of the
    // by_cluster covering index — ~0.15s over 358k faces. The old formulation
    // joined 111k faceClusters rows for COALESCE(personId, clusterId) and
    // sorted 25k groups taking ~4s. With only ~13 merged centroids, JS-side
    // merge is negligible.
    //
    // The filtered variant forces the join order: MATERIALIZED pins the
    // filtered file set, and CROSS JOIN makes it the driving table so faces
    // are probed through the by_file_v3 covering index. Left to itself the
    // planner drove the join from all ~300k clustered faces instead, fetching
    // each face row (and its embedding BLOB pages) to get folder/fileName —
    // ~14s vs ~0.2s under a face filter.
    let aggregateRows: { personId: number; count: number; id: number }[];
    if (whereClause) {
      aggregateRows = await this.db.all<{ personId: number; count: number; id: number }>(
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
      );
    } else {
      // Index-only aggregation: GROUP BY raw clusterId uses the by_cluster
      // covering index without touching face rows or joining faceClusters.
      const clusterRows = await this.db.all<{
        clusterId: number;
        count: number;
        representativeSimilarity: number;
        id: number;
      }>(
        `SELECT clusterId, COUNT(*) AS count,
                MAX(clusterSimilarity) AS representativeSimilarity, id
         FROM faces
         WHERE clusterId > 0
         GROUP BY clusterId
         HAVING COUNT(*) >= ${MIN_FACE_CLUSTER_SIZE}
         ORDER BY COUNT(*) DESC, clusterId`,
      );
      // Merge per-centroid rows into per-person groups in JS.
      // The mergeMap covers only the ~13 faceClusters rows with personId set.
      const mergeRows = await this.db.all<{ id: number; personId: number }>(
        "SELECT id, personId FROM faceClusters WHERE personId IS NOT NULL",
      );
      const mergeMap = new Map(mergeRows.map((r) => [r.id, r.personId]));
      const personMap = new Map<
        number,
        { count: number; repSimilarity: number; id: number }
      >();
      for (const row of clusterRows) {
        const personId = mergeMap.get(row.clusterId) ?? row.clusterId;
        const existing = personMap.get(personId);
        if (!existing) {
          personMap.set(personId, {
            count: row.count,
            repSimilarity: row.representativeSimilarity,
            id: row.id,
          });
        } else {
          existing.count += row.count;
          if (row.representativeSimilarity > existing.repSimilarity) {
            existing.repSimilarity = row.representativeSimilarity;
            existing.id = row.id;
          }
        }
      }
      aggregateRows = [...personMap.entries()]
        .map(([personId, data]) => ({ personId, count: data.count, id: data.id }))
        .sort((a, b) => b.count - a.count || a.personId - b.personId);
    }

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
           WHERE faces.clusterId IS NULL`,
          ...whereParams,
        )
      : await this.db.get<{ count: number }>(
          `SELECT COUNT(*) AS count FROM faces WHERE clusterId IS NULL`,
        );

    // Step 2: hydrate the representative faces — only for the clusters the
    // response actually lists.
    const listed = aggregateRows.slice(0, MAX_FACE_CLUSTERS_LISTED);
    const representatives = new Map<number, FaceClusterFace>();
    const clusterNames = new Map<number, string | null>();
    const clusterTags = new Map<number, string | null>();
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

      const nameRows = await this.db.all<{
        id: number;
        name: string | null;
        tags: string | null;
      }>(
        `SELECT id, name, tags FROM faceClusters WHERE id IN (${listed.map(() => "?").join(", ")})`,
        ...listed.map((row) => row.personId),
      );
      for (const row of nameRows) {
        clusterNames.set(row.id, row.name);
        clusterTags.set(row.id, row.tags);
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
          tags: parsePersonTags(clusterTags.get(row.personId) ?? null),
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
    // unmerged persons (99.9% of cases) can bypass the COALESCE join that
    // forced a full scan of all 111k faceClusters rows (~470ms per query);
    // the direct clusterId = ? lookup uses the by_cluster covering index (1ms).
    const isUnmerged = clusterRow.personId === null;

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
            ${
              isUnmerged
                ? `WHERE faces.clusterId > 0 AND faces.clusterId = ?`
                : `JOIN faceClusters
                     ON faceClusters.id = faces.clusterId
                   WHERE faces.clusterId > 0
                     AND COALESCE(faceClusters.personId, faces.clusterId) = ?`
            }
            ORDER BY faces.clusterSimilarity DESC, faces.id
            LIMIT ${MAX_FACES_IN_CLUSTER_DETAIL}
          )`
      : isUnmerged
        ? `WITH limited AS (
             SELECT id FROM faces
             WHERE clusterId > 0 AND clusterId = ?
             ORDER BY clusterSimilarity DESC, id
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
      `${limitedCTE}
       SELECT
         faces.id,
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
    // list is capped; the unfiltered unmerged path is pure index-only (1ms);
    // the COALESCE variant is kept only for merged persons and filtered queries.
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
      : isUnmerged
        ? await this.db.get<{ count: number }>(
            `SELECT COUNT(*) AS count FROM faces
             WHERE clusterId > 0 AND clusterId = ?`,
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
    const nameRow = await this.db.get<{ name: string | null; tags: string | null }>(
      "SELECT name, tags FROM faceClusters WHERE id = ?",
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
      : isUnmerged
        ? await this.db.all<{ clusterId: number; count: number; id: number }>(
            `SELECT clusterId, COUNT(*) AS count,
                    MAX(clusterSimilarity) AS representativeSimilarity, id
             FROM faces
             WHERE clusterId > 0 AND clusterId = ?
             GROUP BY clusterId`,
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
      return [
        {
          id: faceClusterIdToString(row.clusterId),
          count: row.count,
          representative,
        },
      ];
    });

    const mergeSuggestions = await this.getMergeSuggestions(effectivePersonId, filter);

    return {
      cluster: {
        id: faceClusterIdToString(effectivePersonId),
        count: countRow?.count ?? faces.length,
        representative: faces[0],
        faces,
        name: nameRow?.name ?? null,
        tags: parsePersonTags(nameRow?.tags ?? null),
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
    this.seedsCache = null;
    this.seedsCacheInflight = null;
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

  private async computeFocusedFaceClustersPCA(
    clusterId: string,
  ): Promise<FaceClusterPCAResult> {
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

  private async getMergeSuggestions(
    personId: number,
    filter: QueryOptions["filter"],
  ): Promise<FaceClusterSummary[]> {
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
          ...focusedSeeds.map((focusedSeed) =>
            dotFaceClusterVectors(seed.vector, focusedSeed.vector),
          ),
        ),
      }))
      .sort((a, b) => b.similarity - a.similarity || b.seed.count - a.seed.count)
      .slice(0, MAX_MERGE_SUGGESTIONS);

    // The rest of the detail (faces, count, Match Groups) is scoped to the
    // active filter, so scope the suggested counts to it too — otherwise a
    // suggestion shows its whole-library face count next to filtered numbers.
    // Candidates are all unmerged single clusters (personId === null above), so
    // one grouped count per clusterId is exact. Drop candidates with no faces
    // under the filter: there is nothing filter-relevant to merge.
    const filteredCounts = await this.getFilteredClusterFaceCounts(
      suggestedSeeds.map(({ seed }) => seed.clusterId),
      filter,
    );

    const visibleSuggestions = filteredCounts
      ? suggestedSeeds.flatMap(({ seed }) => {
          const count = filteredCounts.get(seed.clusterId) ?? 0;
          return count > 0 ? [{ seed, count }] : [];
        })
      : suggestedSeeds.map(({ seed }) => ({ seed, count: seed.count }));

    const yearRangeLabels = await this.getFaceClusterYearRangeLabels(
      visibleSuggestions.map(({ seed }) => seed.clusterId),
    );

    return visibleSuggestions.map(({ seed, count }) => ({
      id: seed.id,
      count,
      name: seed.name,
      representative: seed.representative,
      yearRangeLabel: yearRangeLabels.get(seed.clusterId) ?? null,
      // Suggestions are always unmerged single clusters (seed.personId ===
      // null, filtered above), and tags only ever live on a person root —
      // not worth a per-suggestion lookup for a candidate that isn't the
      // real person yet.
      tags: [],
    }));
  }

  /**
   * Per-cluster face counts restricted to the files that pass `filter`. Returns
   * `null` when there is no filter (callers keep their unfiltered counts) so the
   * default People path pays for no extra query. Uses the same MATERIALIZED +
   * CROSS JOIN join-order forcing as queryFaceClusters to stay index-only.
   */
  private async getFilteredClusterFaceCounts(
    clusterIds: number[],
    filter: QueryOptions["filter"],
  ): Promise<Map<number, number> | null> {
    const { where: whereClause, params: whereParams } = filterToSQL(filter);
    if (!whereClause) return null;
    const uniqueClusterIds = [...new Set(clusterIds.filter((id) => id > 0))];
    if (uniqueClusterIds.length === 0) return new Map();

    const rows = await this.db.all<{ clusterId: number; count: number }>(
      `WITH filtered_files AS MATERIALIZED (
         SELECT folder, fileName FROM files WHERE ${whereClause}
       )
       SELECT faces.clusterId AS clusterId, COUNT(*) AS count
       FROM filtered_files
       CROSS JOIN faces
         ON faces.folder = filtered_files.folder
        AND faces.fileName = filtered_files.fileName
       WHERE faces.clusterId IN (${uniqueClusterIds.map(() => "?").join(", ")})
       GROUP BY faces.clusterId`,
      ...whereParams,
      ...uniqueClusterIds,
    );

    return new Map(rows.map((row) => [row.clusterId, row.count]));
  }

  private async getFaceClusterYearRangeLabels(
    clusterIds: number[],
  ): Promise<Map<number, string>> {
    const uniqueClusterIds = [
      ...new Set(clusterIds.filter((clusterId) => clusterId > 0)),
    ];
    if (uniqueClusterIds.length === 0) return new Map();

    const rows = await this.db.all<{
      clusterId: number;
      minDate: number | null;
      maxDate: number | null;
    }>(
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
    // Build the cache at MIN_FACE_CLUSTER_SIZE on first call; filter in memory
    // for higher minCount values. Avoids re-reading 218 MB of centroid BLOBs
    // (+ hydrating 25k representative faces, ~1.7s) on every getMergeSuggestions
    // and computeFocusedFaceClustersPCA call.
    if (!this.seedsCache) {
      if (!this.seedsCacheInflight) {
        this.seedsCacheInflight = this.computeSeedsCache().then((seeds) => {
          this.seedsCache = seeds;
          this.seedsCacheInflight = null;
          return seeds;
        });
      }
      const seeds = await this.seedsCacheInflight!;
      return minCount <= MIN_FACE_CLUSTER_SIZE
        ? seeds
        : seeds.filter((s) => s.count >= minCount);
    }
    return minCount <= MIN_FACE_CLUSTER_SIZE
      ? this.seedsCache
      : this.seedsCache.filter((s) => s.count >= minCount);
  }

  private async computeSeedsCache(): Promise<FaceClusterPCASeed[]> {
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
         HAVING COUNT(*) >= ${MIN_FACE_CLUSTER_SIZE}`,
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

    return centroidRows
      .flatMap((row) => {
        const countEntry = countMap.get(row.id);
        if (!countEntry) return [];
        const representative = repMap.get(countEntry.faceId);
        if (!representative) return [];
        return [
          {
            id: faceClusterIdToString(row.id),
            clusterId: row.id,
            personId: row.personId,
            count: countEntry.count,
            name: row.name ?? null,
            representative,
            vector: normalizeFaceClusterCentroid(
              toAlignedFloat32(row.centroid) as Float32Array<ArrayBuffer>,
            ),
          },
        ];
      })
      .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
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
       WHERE clusterId IS NULL
       ORDER BY confidence DESC
       LIMIT ?`,
      batchSize,
    );
    if (!idRows.length) return 0;

    const faces = await this.db.all<{
      id: number;
      embedding: Buffer;
      confidence: number | null;
    }>(
      `SELECT f.id, fe.embedding, f.confidence FROM faces f
       JOIN faceEmbeddings fe ON fe.faceId = f.id
       WHERE f.id IN (${idRows.map(() => "?").join(", ")})`,
      ...idRows.map((row) => row.id),
    );

    // The id query selects on clusterId alone, which assumes every unassigned
    // face has an embedding row (the migration and detectFaces both stamp
    // UNCLUSTERABLE otherwise). Self-heal if that invariant ever breaks —
    // without this, a face with no embedding would be re-selected forever and
    // the backfill's "handled > 0" loop would never drain.
    if (faces.length < idRows.length) {
      const withEmbeddings = new Set(faces.map((face) => face.id));
      const orphaned = idRows.filter((row) => !withEmbeddings.has(row.id));
      await this.db.transaction(
        orphaned.map((row) => ({
          sql: "UPDATE faces SET clusterId = ? WHERE id = ?",
          params: [UNCLUSTERABLE_CLUSTER_ID, row.id],
        })),
      );
      log.warn(
        { count: orphaned.length },
        "Unassigned faces had no embedding row; marked unclusterable",
      );
    }

    await this.faceClusters.assignFaces(faces);
    // Cluster membership changed — drop the PCA cache so the next request recomputes
    this.invalidateFaceClusterPCACache();
    return idRows.length;
  }

  async pruneEmptyFaceClusters(): Promise<void> {
    await this.faceClusters.pruneEmptyClusters();
    this.invalidateFaceClusterPCACache();
  }

  /**
   * One-time migration (gated by PRAGMA user_version) that retires the hub
   * "garbage" clusters that formed before the confidence gate: low-confidence
   * detections that collapsed into a few magnet clusters mixing non-faces with
   * a thin tail of real faces.
   *
   * Runs before the engine loads its centroids, so its lazy load reflects the
   * post-purge DB. Idempotent regardless of the version guard (a re-run finds no
   * sub-floor clustered faces and no contaminated clusters), so setting the
   * version after the mutations is safe even if the process dies in between.
   */
  private async purgeLowConfidenceFaceClusters(): Promise<void> {
    const versionRow = await this.db.get<{ user_version: number }>(
      "PRAGMA user_version",
    );
    if ((versionRow?.user_version ?? 0) >= LOW_CONFIDENCE_PURGE_VERSION) return;

    // Hubs are defined by their junk: when the sub-floor faces are a large share
    // of a cluster, its confident survivors aren't necessarily one person, so
    // free them (clusterId NULL) for the backfill to re-cluster cleanly. A
    // healthy cluster that merely sheds a straggler keeps its assignment — the
    // leftover ghost weight in its centroid is negligible and self-corrects.
    const contaminated = await this.db.all<{ clusterId: number }>(
      `SELECT clusterId FROM faces
       WHERE clusterId > 0
       GROUP BY clusterId
       HAVING SUM(CASE WHEN confidence < ? THEN 1 ELSE 0 END) * 1.0 / COUNT(*) >= ?
          AND SUM(CASE WHEN confidence >= ? THEN 1 ELSE 0 END) > 0`,
      MIN_FACE_CONFIDENCE_FOR_CLUSTERING,
      HUB_RECLUSTER_PURGE_FRACTION,
      MIN_FACE_CONFIDENCE_FOR_CLUSTERING,
    );
    const contaminatedIds = contaminated.map((row) => row.clusterId);

    const statements: Array<{ sql: string; params: unknown[] }> = [
      // Evict every sub-floor detection to the low-confidence sentinel.
      {
        sql: "UPDATE faces SET clusterId = ?, clusterSimilarity = NULL WHERE clusterId > 0 AND confidence < ?",
        params: [LOW_CONFIDENCE_CLUSTER_ID, MIN_FACE_CONFIDENCE_FOR_CLUSTERING],
      },
    ];
    // Free the confident survivors of hub clusters for re-clustering.
    for (let i = 0; i < contaminatedIds.length; i += 500) {
      const chunk = contaminatedIds.slice(i, i + 500);
      statements.push({
        sql: `UPDATE faces SET clusterId = NULL, clusterSimilarity = NULL
              WHERE clusterId IN (${chunk.map(() => "?").join(", ")})`,
        params: chunk,
      });
    }
    // Drop centroid rows left with no confident members: the fully-emptied hubs
    // and the contaminated clusters whose survivors we just reset to NULL.
    statements.push({
      sql: "DELETE FROM faceClusters WHERE id NOT IN (SELECT DISTINCT clusterId FROM faces WHERE clusterId > 0)",
      params: [],
    });

    await this.db.transaction(statements);
    // PRAGMA can't run inside the batch transaction and can't be parameterized;
    // the version is a trusted integer literal.
    await this.db.exec(`PRAGMA user_version = ${LOW_CONFIDENCE_PURGE_VERSION}`);
    this.invalidateFaceClusterPCACache();
    log.info(
      { reclusteredHubs: contaminatedIds.length },
      "Purged low-confidence face detections from clustering",
    );
  }

  /**
   * One-time migration (gated by PRAGMA user_version) that rescores the stored
   * clusterSimilarity of already-merged sub-clusters against their person's
   * canonical centroid. Before rescore-on-merge existed, merging only regrouped
   * personId and left each sub-cluster's seed pinned at 1.0, so a merged
   * person's representative/detail order surfaced arbitrary sub-cluster seeds
   * (often tiny background faces) ahead of the real centroid faces. Idempotent:
   * a re-run recomputes the same similarities.
   */
  private async rescoreMergedClusterSimilarities(): Promise<void> {
    const versionRow = await this.db.get<{ user_version: number }>(
      "PRAGMA user_version",
    );
    if ((versionRow?.user_version ?? 0) >= MERGED_SIMILARITY_RESCORE_VERSION) return;

    // Sub-clusters are the rows whose personId points at a *different* canonical
    // cluster; the canonical cluster's own faces are already scored against its
    // centroid. Group the sub-clusters by their canonical id and rescore each
    // group's faces against that canonical centroid.
    const subClusters = await this.db.all<{ id: number; personId: number }>(
      "SELECT id, personId FROM faceClusters WHERE personId IS NOT NULL AND personId != id",
    );
    const byCanonical = new Map<number, number[]>();
    for (const row of subClusters) {
      const list = byCanonical.get(row.personId) ?? [];
      list.push(row.id);
      byCanonical.set(row.personId, list);
    }
    for (const [canonicalId, subjectIds] of byCanonical) {
      await this.faceClusters.rescoreFacesAgainstCluster(canonicalId, subjectIds);
    }

    await this.db.exec(`PRAGMA user_version = ${MERGED_SIMILARITY_RESCORE_VERSION}`);
    this.invalidateFaceClusterPCACache();
    log.info(
      { persons: byCanonical.size, subClusters: subClusters.length },
      "Rescored merged sub-cluster similarities against canonical centroids",
    );
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
  private async resetStaleFaceAttributes(): Promise<void> {
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

  /**
   * Rescores stored per-face similarities against current centroids for drifted
   * clusters, so People-tab representatives stop sticking to the seed face.
   * Returns the number of clusters refreshed; 0 means nothing was stale.
   */
  refreshStaleClusterSimilarities(): Promise<number> {
    return this.faceClusters.refreshStaleClusterSimilarities();
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
        await this.db.run(
          "UPDATE faceClusters SET name = NULL WHERE id = ?",
          clusterRow.id,
        );
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

  async mergeClusters(
    sourceClusterId: string,
    targetClusterId: string,
  ): Promise<boolean> {
    const sourceId = faceClusterIdFromString(sourceClusterId);
    const targetId = faceClusterIdFromString(targetClusterId);
    if (sourceId === null || targetId === null || sourceId <= 0 || targetId <= 0)
      return false;
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
      this.db.get<{ name: string | null }>(
        "SELECT name FROM faceClusters WHERE id = ?",
        sourcePersonId,
      ),
      this.db.get<{ name: string | null }>(
        "SELECT name FROM faceClusters WHERE id = ?",
        targetPersonId,
      ),
    ]);

    const canonicalTargetId =
      targetPersonRow?.name == null && sourcePersonRow?.name != null
        ? sourcePersonId
        : targetPersonId;
    const movedPersonId =
      canonicalTargetId === sourcePersonId ? targetPersonId : sourcePersonId;
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

    // Rescore the moved sub-clusters' faces against the person's canonical
    // centroid so the merged person's clusterSimilarity values share one scale;
    // otherwise each moved sub-cluster's seed stays pinned at 1.0 and dominates
    // the person's representative/detail order with an arbitrary face. The
    // canonical cluster's own faces are already scored against this centroid.
    await this.faceClusters.rescoreFacesAgainstCluster(
      canonicalTargetId,
      movedClusterRows.map((row) => row.id),
    );

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
    if (
      !clusterRow ||
      clusterRow.personId === null ||
      clusterRow.personId === clusterRow.id
    ) {
      return false;
    }

    await this.db.run(
      "UPDATE faceClusters SET personId = NULL, name = NULL WHERE id = ?",
      clusterRow.id,
    );

    // The cluster is a standalone person again; restore self-scoring so its
    // similarities are relative to its own centroid rather than the former
    // person's canonical one (set when it was merged in).
    await this.faceClusters.rescoreFacesAgainstCluster(clusterRow.id, [clusterRow.id]);

    this.invalidateFaceClusterPCACache();
    return true;
  }

  /**
   * Sets (replacing) the tag list for the person a cluster resolves to.
   * Mirrors renameCluster's root-resolution: tags always live on the person
   * root row (id = COALESCE(personId, id)), never on a merged-in member, so
   * they survive future merges/separations the same way `name` does.
   */
  async setClusterTags(clusterId: string, tags: string[]): Promise<boolean> {
    const numericId = faceClusterIdFromString(clusterId);
    if (numericId === null || numericId <= 0) return false;

    const clusterRow = await this.db.get<{ id: number; personId: number | null }>(
      "SELECT id, personId FROM faceClusters WHERE id = ?",
      numericId,
    );
    if (!clusterRow) return false;

    const effectivePersonId = clusterRow.personId ?? clusterRow.id;
    const normalized = [
      ...new Set(tags.map((t) => t.trim()).filter((t) => t.length > 0)),
    ];
    await this.db.run(
      "UPDATE faceClusters SET tags = ? WHERE id = ?",
      normalized.length > 0 ? JSON.stringify(normalized) : null,
      effectivePersonId,
    );
    return true;
  }

  /** Distinct tags across every named/tagged person, for filter-panel suggestions. */
  async getAllPersonTags(): Promise<string[]> {
    const rows = await this.db.all<{ tags: string }>(
      "SELECT tags FROM faceClusters WHERE tags IS NOT NULL",
    );
    const all = new Set<string>();
    for (const row of rows) {
      try {
        for (const tag of JSON.parse(row.tags) as unknown[]) {
          if (typeof tag === "string") all.add(tag);
        }
      } catch {
        // Malformed JSON shouldn't happen (only written via setClusterTags),
        // but skip rather than throw on a suggestions query.
      }
    }
    return [...all].sort();
  }

  /**
   * Feedback #90: pulls one outlier detection out of the cluster it's
   * currently in. `faceId` must still belong to a real cluster (`clusterId >
   * 0`) — a face already excluded, low-confidence, or unclusterable is a
   * no-op (`false`). See FaceClusterEngine.excludeFace for the centroid math
   * and the sentinel/exclusion-record write.
   */
  async excludeFaceFromCluster(faceId: number): Promise<boolean> {
    const row = await this.db.get<{ clusterId: number | null; embedding: Buffer | null }>(
      `SELECT f.clusterId AS clusterId, fe.embedding AS embedding
       FROM faces f
       LEFT JOIN faceEmbeddings fe ON fe.faceId = f.id
       WHERE f.id = ?`,
      faceId,
    );
    if (!row || row.clusterId === null || row.clusterId <= 0 || !row.embedding) {
      return false;
    }

    await this.faceClusters.excludeFace({
      id: faceId,
      clusterId: row.clusterId,
      embedding: row.embedding,
    });
    this.invalidateFaceClusterPCACache();
    return true;
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

  /**
   * Centroids of every cluster that resolves to a *named* person — the lookup
   * table for matching a face from outside the library (a doorbell frame, an
   * uploaded snap) against people already identified in the People tab.
   *
   * One row per cluster, not per person: merging carries the name on the person
   * root rather than copying it onto each member, so a person can own several
   * centroids (a beard year, a childhood). Keeping them separate means a live
   * face only has to resemble one of a person's looks rather than their average
   * across all of them; callers collapse by name.
   */
  async getNamedFaceCentroids(): Promise<
    Array<{ clusterId: number; name: string; centroid: Buffer }>
  > {
    const rows = await this.db.all<{ id: number; name: string; centroid: Buffer }>(
      `SELECT
         faceClusters.id AS id,
         COALESCE(personRoots.name, faceClusters.name) AS name,
         faceClusters.centroid AS centroid
       FROM faceClusters
       LEFT JOIN faceClusters AS personRoots
         ON personRoots.id = faceClusters.personId
       WHERE faceClusters.weight > 0
         AND COALESCE(personRoots.name, faceClusters.name) IS NOT NULL`,
    );
    return rows.map((row) => ({
      clusterId: row.id,
      name: row.name,
      centroid: row.centroid,
    }));
  }

  /** Cheap index-only counts — polled by the backfill task's status hook. */
  async getFaceClusteringProgress(): Promise<{ assigned: number; pending: number }> {
    const [assignedRow, pendingRow] = await Promise.all([
      this.db.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM faces WHERE clusterId > 0",
      ),
      this.db.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM faces WHERE clusterId IS NULL",
      ),
    ]);
    return { assigned: assignedRow?.count ?? 0, pending: pendingRow?.count ?? 0 };
  }

  // ===== Moment clustering (burst / near-duplicate stacks) =====
  // See momentClusterEngine.ts for the algorithm this backs.

  /**
   * Next batch of images the moment-clustering task hasn't evaluated yet, in
   * capture-time order — the scan has to walk dateTaken order to chain
   * temporally-adjacent photos. Only images with a decodable CLIP embedding are
   * eligible (a photo with no embedding can never be compared, so it is left
   * unprocessed rather than force-included with no signal); it is retried
   * automatically once imageAnalysis embeds it, since that stage's onDrain
   * re-queues this one (see registerBackgroundTasks.ts).
   *
   * Newest-first (2026-08-12): the backlog is large enough (~192k photos)
   * that an oldest-first sweep left recent photos — the ones users actually
   * browse — unprocessed for days, even though clusters further back were
   * already forming correctly. Flipping the order here means the *next*
   * batch fetched is always the newest still-unprocessed slice, so results
   * show up in front of normal recent-photos browsing almost immediately.
   * Already-processed rows (regardless of when they were processed, or in
   * which direction) are untouched by this — they're simply excluded via
   * momentClusterProcessedAt IS NOT NULL, same as before. See
   * getMomentClusteringSweepSeedState for the matching change to how a
   * resumed run reconstructs chain continuity.
   */
  async getMomentClusteringBatch(
    limit: number,
  ): Promise<
    Array<{
      folder: string;
      fileName: string;
      dateTaken: number;
      embedding: Float32Array;
    }>
  > {
    const rows = await this.db.all<{
      folder: string;
      fileName: string;
      dateTaken: number;
      imageEmbedding: Buffer | null;
    }>(
      `SELECT files.folder, files.fileName, files.dateTaken, fileEmbeddings.imageEmbedding
       FROM files
       JOIN fileEmbeddings
         ON fileEmbeddings.folder = files.folder AND fileEmbeddings.fileName = files.fileName
       WHERE files.mimeType LIKE 'image/%'
         AND files.momentClusterProcessedAt IS NULL
         AND files.dateTaken IS NOT NULL
         AND fileEmbeddings.imageEmbedding IS NOT NULL
       ORDER BY files.dateTaken DESC, files.folder DESC, files.fileName DESC
       LIMIT ?`,
      limit,
    );

    const out: Array<{
      folder: string;
      fileName: string;
      dateTaken: number;
      embedding: Float32Array;
    }> = [];
    for (const row of rows) {
      const embedding = decodeEmbedding(row.imageEmbedding);
      if (!embedding) {
        // Undecodable (corrupt/zero) — stamp it processed-with-no-cluster so
        // the backfill doesn't retry it forever, same treatment as faces'
        // UNCLUSTERABLE_CLUSTER_ID.
        await this.db.run(
          `UPDATE files SET momentClusterProcessedAt = ? WHERE folder = ? AND fileName = ?`,
          Date.now(),
          row.folder,
          row.fileName,
        );
        continue;
      }
      out.push({
        folder: row.folder,
        fileName: row.fileName,
        dateTaken: row.dateTaken,
        embedding,
      });
    }
    return out;
  }

  /**
   * Reconstructs the clustering chain state as of just before the sweep's
   * next batch starts (`adjacentDateTaken` is that batch's first item's
   * dateTaken) — the nearest already-*processed* file on the side the sweep
   * is coming *from*, and, if it belongs to a cluster, that cluster's
   * persisted running centroid. Lets the task resume correctly after a
   * restart or across batch boundaries without re-scanning already-processed
   * files.
   *
   * Direction-aware (2026-08-12): the sweep now consumes the backlog
   * newest-first (see getMomentClusteringBatch), so "just before" in
   * *processing order* means "immediately newer in *capture time*" — this
   * looks for the nearest processed file with dateTaken >= the threshold,
   * not <=. Renamed from getPrecedingMomentClusterState (which searched
   * dateTaken <= threshold, correct for the old oldest-first sweep) to avoid
   * a misleading name now that "preceding" means something different.
   */
  async getMomentClusteringSweepSeedState(adjacentDateTaken: number): Promise<{
    clusterId: number | null;
    centroidSum: Float32Array;
    weight: number;
    dateTaken: number;
    /** Only meaningful when clusterId is null — the standalone predecessor's
     * own path, so it can be retroactively promoted if the next file joins it. */
    folder: string;
    fileName: string;
  } | null> {
    const row = await this.db.get<{
      folder: string;
      fileName: string;
      dateTaken: number;
      momentClusterId: number | null;
      imageEmbedding: Buffer | null;
    }>(
      `SELECT files.folder, files.fileName, files.dateTaken, files.momentClusterId,
              fileEmbeddings.imageEmbedding
       FROM files
       LEFT JOIN fileEmbeddings
         ON fileEmbeddings.folder = files.folder AND fileEmbeddings.fileName = files.fileName
       WHERE files.momentClusterProcessedAt IS NOT NULL
         AND files.dateTaken IS NOT NULL
         AND files.dateTaken >= ?
       ORDER BY files.dateTaken ASC, files.folder ASC, files.fileName ASC
       LIMIT 1`,
      adjacentDateTaken,
    );
    if (!row) return null;

    if (row.momentClusterId) {
      const cluster = await this.db.get<{ centroid: Buffer | null; weight: number }>(
        `SELECT centroid, weight FROM momentClusters WHERE id = ?`,
        row.momentClusterId,
      );
      if (cluster?.centroid && cluster.weight > 0) {
        const decoded = decodeEmbedding(cluster.centroid);
        if (decoded) {
          // decodeEmbedding re-normalizes to unit length; scale back up so the
          // running-sum math in momentClusterEngine (which divides by weight)
          // reconstructs the same average.
          const centroidSum = new Float32Array(decoded.length);
          for (let i = 0; i < decoded.length; i += 1) {
            centroidSum[i] = decoded[i] * cluster.weight;
          }
          return {
            clusterId: row.momentClusterId,
            centroidSum,
            weight: cluster.weight,
            dateTaken: row.dateTaken,
            folder: row.folder,
            fileName: row.fileName,
          };
        }
      }
    }

    // Standalone predecessor (no cluster, or its embedding/centroid couldn't be
    // read) — seed a fresh single-file candidate chain from its own embedding.
    const embedding = decodeEmbedding(row.imageEmbedding);
    if (!embedding) return null;
    return {
      clusterId: null,
      centroidSum: embedding,
      weight: 1,
      dateTaken: row.dateTaken,
      folder: row.folder,
      fileName: row.fileName,
    };
  }

  /** Creates a new moment cluster row and returns its id. */
  async createMomentCluster(): Promise<number> {
    const now = Date.now();
    const result = await this.db.run(
      `INSERT INTO momentClusters (weight, createdAt, updatedAt, representativePinned) VALUES (0, ?, ?, 0)`,
      now,
      now,
    );
    return Number(result.lastInsertRowid);
  }

  /**
   * Retroactively assigns a already-processed, already-written file to a
   * moment cluster — used when that file was the sole member of an open chain
   * (momentClusterId left NULL) and a later file joins it, confirming the
   * chain is a real cluster after the fact. Leaves sharpnessScore and
   * momentClusterProcessedAt untouched; only the cluster assignment changes.
   */
  async promoteFileToMomentCluster(
    folder: string,
    fileName: string,
    clusterId: number,
  ): Promise<void> {
    await this.db.run(
      `UPDATE files SET momentClusterId = ? WHERE folder = ? AND fileName = ?`,
      clusterId,
      folder,
      fileName,
    );
  }

  /** Persists a moment cluster's running centroid (used as new members join). */
  async saveMomentClusterCentroid(
    clusterId: number,
    centroidSum: Float32Array,
    weight: number,
  ): Promise<void> {
    // Store the *normalized average*, not the raw sum: encodeEmbedding
    // unit-normalizes whatever it's given, and getMomentClusteringSweepSeedState
    // rescales it back up by `weight` on read, so storing the average (rather
    // than a sum that keeps growing in magnitude) keeps the encode step's
    // int8 quantization grid well-used regardless of cluster size.
    const average = new Float32Array(centroidSum.length);
    for (let i = 0; i < centroidSum.length; i += 1) average[i] = centroidSum[i] / weight;
    const encoded = encodeEmbedding(average);
    await this.db.run(
      `UPDATE momentClusters SET centroid = ?, weight = ?, updatedAt = ? WHERE id = ?`,
      encoded,
      weight,
      Date.now(),
      clusterId,
    );
  }

  /**
   * Writes one batch's worth of clustering decisions: each file's assigned
   * momentClusterId (or null for "stands alone"), its computed sharpness
   * score, and the processed-marker timestamp.
   */
  async saveMomentClusteringBatch(
    updates: Array<{
      folder: string;
      fileName: string;
      momentClusterId: number | null;
      sharpnessScore: number | null;
    }>,
  ): Promise<void> {
    const now = Date.now();
    await this.db.transaction(
      updates.map((update) => ({
        sql: `UPDATE files SET momentClusterId = ?, sharpnessScore = ?, momentClusterProcessedAt = ?
              WHERE folder = ? AND fileName = ?`,
        params: [
          update.momentClusterId,
          update.sharpnessScore,
          now,
          update.folder,
          update.fileName,
        ],
      })),
    );
  }

  /**
   * Re-ranks a cluster's members (see momentClusterEngine.pickRepresentative)
   * and writes the winner's momentClusterRepresentative flag. No-op if the
   * cluster's representative was manually pinned by a user (see
   * setMomentClusterRepresentative).
   */
  async recomputeMomentClusterRepresentative(clusterId: number): Promise<void> {
    const cluster = await this.db.get<{ representativePinned: number }>(
      `SELECT representativePinned FROM momentClusters WHERE id = ?`,
      clusterId,
    );
    if (!cluster || cluster.representativePinned) return;

    const members = await this.db.all<{
      folder: string;
      fileName: string;
      sharpnessScore: number | null;
      photoQualityScore: number | null;
    }>(
      `SELECT folder, fileName, sharpnessScore, photoQualityScore FROM files WHERE momentClusterId = ?`,
      clusterId,
    );
    const winner = pickRepresentative(members);
    if (!winner) return;

    await this.db.transaction([
      {
        sql: `UPDATE files SET momentClusterRepresentative = 0 WHERE momentClusterId = ?`,
        params: [clusterId],
      },
      {
        sql: `UPDATE files SET momentClusterRepresentative = 1 WHERE folder = ? AND fileName = ?`,
        params: [winner.folder, winner.fileName],
      },
    ]);
  }

  /** Progress counters for the moment-clustering task's status display. */
  async getMomentClusteringProgress(): Promise<{ processed: number; pending: number }> {
    const [processedRow, pendingRow] = await Promise.all([
      this.db.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM files WHERE mimeType LIKE 'image/%' AND momentClusterProcessedAt IS NOT NULL`,
      ),
      this.db.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM files WHERE mimeType LIKE 'image/%' AND momentClusterProcessedAt IS NULL AND dateTaken IS NOT NULL`,
      ),
    ]);
    return { processed: processedRow?.count ?? 0, pending: pendingRow?.count ?? 0 };
  }

  /**
   * Full member listing for one moment cluster — powers the gallery's "expand
   * this stack" interaction. Ordered representative-first, then by descending
   * quality score so the next-best pick is easy to find.
   */
  async getMomentClusterDetail(clusterId: string): Promise<MomentClusterDetail | null> {
    const numericId = Number.parseInt(clusterId, 10);
    if (!Number.isFinite(numericId)) return null;

    const rows = await this.db.all<{
      folder: string;
      fileName: string;
      mimeType: string | null;
      dimensionsWidth: number | null;
      dimensionsHeight: number | null;
      momentClusterRepresentative: number;
      sharpnessScore: number | null;
      photoQualityScore: number | null;
    }>(
      `SELECT folder, fileName, mimeType, dimensionsWidth, dimensionsHeight,
              momentClusterRepresentative, sharpnessScore, photoQualityScore
       FROM files
       WHERE momentClusterId = ?
       ORDER BY momentClusterRepresentative DESC, photoQualityScore DESC, sharpnessScore DESC`,
      numericId,
    );
    if (rows.length === 0) return null;

    return {
      id: clusterId,
      members: rows.map((row) => ({
        path: row.folder + row.fileName,
        fileName: row.fileName,
        mimeType: row.mimeType,
        dimensionWidth: row.dimensionsWidth,
        dimensionHeight: row.dimensionsHeight,
        isRepresentative: Number(row.momentClusterRepresentative) === 1,
        sharpnessScore: row.sharpnessScore,
        photoQualityScore: row.photoQualityScore,
      })),
    };
  }

  /**
   * User override: makes `relativePath` the cluster's representative and pins
   * it, so the automatic sharpness/quality re-scoring in
   * recomputeMomentClusterRepresentative never overwrites the choice again.
   * Returns false if the cluster or the file (as a member of it) doesn't exist.
   */
  async setMomentClusterRepresentative(
    clusterId: string,
    relativePath: string,
  ): Promise<boolean> {
    const numericId = Number.parseInt(clusterId, 10);
    if (!Number.isFinite(numericId)) return false;
    const { folder, fileName } = splitPath(relativePath);

    const member = await this.db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM files WHERE momentClusterId = ? AND folder = ? AND fileName = ?`,
      numericId,
      folder,
      fileName,
    );
    if (!member || member.count === 0) return false;

    await this.db.transaction([
      {
        sql: `UPDATE files SET momentClusterRepresentative = 0 WHERE momentClusterId = ?`,
        params: [numericId],
      },
      {
        sql: `UPDATE files SET momentClusterRepresentative = 1 WHERE folder = ? AND fileName = ?`,
        params: [folder, fileName],
      },
      {
        sql: `UPDATE momentClusters SET representativePinned = 1, updatedAt = ? WHERE id = ?`,
        params: [Date.now(), numericId],
      },
    ]);
    return true;
  }

  /**
   * Permanently dissolves a moment cluster: every member's momentClusterId and
   * momentClusterRepresentative are cleared (so they behave like ordinary,
   * never-clustered photos and each show individually in the gallery from now
   * on) and the cluster row itself is deleted. This is the "unstack
   * permanently" action; the temporary/session-only version never reaches the
   * database at all — it's purely client-side state.
   *
   * Members are left with momentClusterProcessedAt already set, so the
   * background task never re-evaluates or re-clusters them.
   */
  async dissolveMomentCluster(clusterId: string): Promise<boolean> {
    const numericId = Number.parseInt(clusterId, 10);
    if (!Number.isFinite(numericId)) return false;

    const existing = await this.db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM files WHERE momentClusterId = ?`,
      numericId,
    );
    if (!existing || existing.count === 0) return false;

    await this.db.transaction([
      {
        sql: `UPDATE files SET momentClusterId = NULL, momentClusterRepresentative = 0 WHERE momentClusterId = ?`,
        params: [numericId],
      },
      { sql: `DELETE FROM momentClusters WHERE id = ?`, params: [numericId] },
    ]);
    return true;
  }

  /**
   * Cleans up "cluster" rows that ended up with only one member and dissolves
   * them (same effect as dissolveMomentCluster, just automatic). A cluster is
   * only ever *created* when a second photo joins one — see
   * processMomentClustering.ts — but the result can still end up a singleton:
   *
   *  - A process restart mid-batch can leave a cluster's first member eagerly
   *    promoted (a direct, unbatched write via promoteFileToMomentCluster)
   *    while the second member's own join never got committed (it was queued
   *    in the same batch's still-in-flight transaction).
   *  - Confirmed live on 2026-08-12: this also happens during perfectly
   *    ordinary, uninterrupted operation — not just restarts (root cause not
   *    yet isolated; suspected to involve the in-batch chain-reassignment
   *    path when a cluster is created and then broken again within the same
   *    batch). This was found via a direct DB inspection showing thousands of
   *    singleton clusters with `momentClusterProcessedAt` timestamps from
   *    hours of continuous runtime, no restart in between.
   *
   * Either way the result is harmless to what users see — a stack badge only
   * ever shows for count > 1, and the collapsed gallery query still returns
   * the lone "member" as an ordinary photo — but it's DB clutter, and the
   * member's momentClusterProcessedAt marker is already set so the background
   * task will never revisit it on its own. Called periodically (every
   * PRUNE_SINGLETONS_EVERY_N_BATCHES batches, not just once at full backlog
   * drain — see processMomentClustering.ts's comment for why "once at drain"
   * turned out to be effectively dead code on a library this size).
   */
  async pruneSingletonMomentClusters(): Promise<number> {
    const orphans = await this.db.all<{ momentClusterId: number }>(
      `SELECT momentClusterId FROM files
       WHERE momentClusterId IS NOT NULL
       GROUP BY momentClusterId
       HAVING COUNT(*) = 1`,
    );
    if (orphans.length === 0) return 0;

    await this.db.transaction(
      orphans.flatMap(({ momentClusterId }) => [
        {
          sql: `UPDATE files SET momentClusterId = NULL, momentClusterRepresentative = 0 WHERE momentClusterId = ?`,
          params: [momentClusterId],
        },
        { sql: `DELETE FROM momentClusters WHERE id = ?`, params: [momentClusterId] },
      ]),
    );
    return orphans.length;
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

    const queryBuffer = encodeEmbedding(queryVector);
    if (!queryBuffer) return [];

    // The embedding is joined in from fileEmbeddings rather than read off the
    // row. The join subquery renames its key columns so `folder`/`fileName` in
    // the caller-supplied filter fragment stay unambiguously `files`'.
    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT files.*, cosine_similarity_i8(emb.vector, ?) AS similarity
       FROM files
       JOIN (
         SELECT folder AS embFolder, fileName AS embFileName, audioEmbedding AS vector
         FROM fileEmbeddings WHERE audioEmbedding IS NOT NULL
       ) AS emb ON emb.embFolder = files.folder AND emb.embFileName = files.fileName
       WHERE (
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
    // V8's heap. Pushing the similarity into the ORDER BY ... LIMIT keeps the
    // per-row embedding work in C and returns only `limit` rows.
    const queryBuffer = encodeEmbedding(queryVector);
    if (!queryBuffer) return [];

    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT files.*, cosine_similarity_i8(emb.vector, ?) AS similarity
       FROM files
       JOIN (
         SELECT folder AS embFolder, fileName AS embFileName, imageEmbedding AS vector
         FROM fileEmbeddings WHERE imageEmbedding IS NOT NULL
       ) AS emb ON emb.embFolder = files.folder AND emb.embFileName = files.fileName
       WHERE (mimeType LIKE 'image/%')
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
    // Record the warm so the post-checkpoint throttle counts explicit warms
    // (startup, search-warmup) too, and doesn't immediately re-scan right after.
    this.lastSemanticWarmAt = Date.now();
    await this.semanticSearch(probe, {}, 1);
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
    if (metadata?.includes("momentClusterSize" as keyof FileRecord)) {
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
    if (metadata?.includes("momentClusterPreviewPaths" as keyof FileRecord)) {
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
