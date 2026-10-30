import { access } from "node:fs/promises";
import path from "node:path";
import { getMirroredCachedFilePath } from "../common/cacheUtils.ts";
import type { StandardHeight } from "../common/standardHeights.ts";
import { stripLeadingSlash } from "../common/stripLeadingSlash.ts";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { getLogger } from "../observability/logger.ts";
import { createTaskController } from "../taskOrchestrator/taskController.ts";
import { getNormalizedLoad } from "../taskOrchestrator/systemLoad.ts";
import type { TaskRunner } from "../taskOrchestrator/taskOrchestrator.ts";
import { generateVideoThumbnail } from "../videoProcessing/videoUtils.ts";
import { convertImageToMultipleSizes, IMAGE_OUTPUT_EXTENSION } from "./convertImage.ts";
import { convertEmbeddedThumbnail } from "./embeddedThumbnail.ts";

const log = getLogger("thumbnailBackfill");

// ---------------------------------------------------------------------------
// Grid-thumbnail backfill.
//
// Grid tiles are otherwise generated on first view, so scrolling into a folder
// nobody has opened before decodes every original off the media share while
// the user waits (3–7 s a screenful, measured 2026-10-20). This pass makes the
// same files ahead of time: the 160 micro tile and the 320 tile for every
// photo, and the 320 frame for every video. It walks the library in the grid's
// own default order (newest first), so the tiles people scroll to first are
// made first.
//
// It runs at any hour as the lowest-priority background work there is:
//   - one file at a time, pausing between files whenever the orchestrator sees
//     user activity, so a live request never queues behind it for long;
//   - it holds off entirely while the machine is busy (1-minute load above
//     half the CPUs) — other background stages, transcodes, other guests;
//   - after each file it rests as long as the file took, so even on an idle
//     machine it is working at most about half the time;
//   - source reads are capped (default 10 MB/s), since the whole library is
//     ~730 GB off the NAS.
//
// What still needs doing is read off the cache on disk rather than a DB
// column: a cache entry that is deleted (a source file changed, a manual
// sweep) is simply regenerated on the next pass. The thumbnails it makes are
// exempt from LRU eviction (see cacheEviction.ts), or the 10 GB budget would
// slowly undo the work.
// ---------------------------------------------------------------------------

/** The two grid sizes a photo tile requests: `representation=micro`, then 320. */
const MICRO_HEIGHT = 160;
const TILE_HEIGHT = 320;

/** A video thumbnail is one frame near the start; ffmpeg reads far less than the file. */
const VIDEO_THUMBNAIL_READ_ESTIMATE_BYTES = 8 * 1024 * 1024;
/** Used when the index has no size for a photo yet. */
const DEFAULT_IMAGE_READ_ESTIMATE_BYTES = 5 * 1024 * 1024;

const DEFAULT_MB_PER_SECOND = 10;
/** 1-minute load average per CPU above which the pass waits for the machine to quieten. */
const DEFAULT_MAX_LOAD = 0.5;
const LOAD_POLL_MS = 5_000;
/** Rest after each file, as a multiple of how long it took. 1 = work at most half the time. */
const REST_PER_WORK = 1;
/** Bound on one rest, so a single pathological file can't park the pass. */
const MAX_REST_MS = 10_000;
/**
 * How often a running pass re-reads the file list. The first pass over a large
 * library takes days; without this, photos added meanwhile — the newest, and
 * so the first ones anyone scrolls to — would wait for it to finish.
 */
const CANDIDATE_REFRESH_MS = 10 * 60_000;

type ThumbnailBackfillLimits = {
  bytesPerSecond: number;
  /** Normalized 1-minute load (1.0 = every CPU busy) the pass waits beneath. */
  maxLoad: number;
};

type ThumbnailBackfillConfig = ThumbnailBackfillLimits & {
  /** Read before every file, so switching the feature flag takes effect at once. */
  isEnabled: () => boolean;
};

const positiveNumber = (raw: string | undefined, fallback: number): number => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export const readThumbnailBackfillLimits = (
  env: NodeJS.ProcessEnv = process.env,
): ThumbnailBackfillLimits => ({
  bytesPerSecond:
    positiveNumber(env.PHOTRIX_THUMBNAIL_BACKFILL_MB_PER_SEC, DEFAULT_MB_PER_SECOND) *
    1024 *
    1024,
  maxLoad: positiveNumber(env.PHOTRIX_THUMBNAIL_BACKFILL_MAX_LOAD, DEFAULT_MAX_LOAD),
});

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** How long to rest after a file that took `workMs` to make. */
export const restAfter = (workMs: number): number =>
  Math.min(Math.max(0, workMs) * REST_PER_WORK, MAX_REST_MS);

/**
 * Paces source reads to `bytesPerSecond`: each call waits until the bytes the
 * previous calls were charged for have "drained", then charges its own.
 */
export const createReadPacer = (
  bytesPerSecond: number,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = defaultSleep,
) => {
  let availableAt = 0;
  return async (bytes: number): Promise<void> => {
    const wait = availableAt - now();
    if (wait > 0) await sleep(wait);
    availableAt = Math.max(availableAt, now()) + (bytes / bytesPerSecond) * 1000;
  };
};

const exists = (filePath: string): Promise<boolean> =>
  access(filePath).then(
    () => true,
    () => false,
  );

type PlannedWork = { readBytes: number; run: () => Promise<unknown> };

/**
 * Decides what a file still needs, checking only the local cache (never the
 * share). Returns null when every grid thumbnail for it already exists.
 */
export const planThumbnailWork = async (
  fullPath: string,
  mimeType: string,
  sizeInBytes: number | null,
): Promise<PlannedWork | null> => {
  if (mimeType.startsWith("video/")) {
    if (await exists(getMirroredCachedFilePath(fullPath, TILE_HEIGHT, "jpg")))
      return null;
    return {
      readBytes: VIDEO_THUMBNAIL_READ_ESTIMATE_BYTES,
      run: () =>
        generateVideoThumbnail(fullPath, TILE_HEIGHT, { priority: "background" }),
    };
  }

  // The micro tile is either the JPEG's embedded EXIF thumbnail (160.micro2)
  // or, when there is none, a full-decode 160 — see tryMicroThumbnail.
  const [hasTile, hasEmbeddedMicro, hasDecodedMicro] = await Promise.all([
    exists(getMirroredCachedFilePath(fullPath, TILE_HEIGHT, IMAGE_OUTPUT_EXTENSION)),
    exists(
      getMirroredCachedFilePath(
        fullPath,
        `${MICRO_HEIGHT}.micro2`,
        IMAGE_OUTPUT_EXTENSION,
      ),
    ),
    exists(getMirroredCachedFilePath(fullPath, MICRO_HEIGHT, IMAGE_OUTPUT_EXTENSION)),
  ]);
  const hasMicro = hasEmbeddedMicro || hasDecodedMicro;
  if (hasTile && hasMicro) return null;

  return {
    readBytes: sizeInBytes ?? DEFAULT_IMAGE_READ_ESTIMATE_BYTES,
    run: async () => {
      // Header-only read; only JPEGs carry an embedded thumbnail worth using.
      const embedded =
        !hasMicro && mimeType === "image/jpeg"
          ? await convertEmbeddedThumbnail(fullPath, MICRO_HEIGHT)
          : null;
      const heights: StandardHeight[] = [];
      if (!hasTile) heights.push(TILE_HEIGHT);
      if (!hasMicro && !embedded) heights.push(MICRO_HEIGHT);
      // One decode writes both sizes.
      if (heights.length > 0) {
        await convertImageToMultipleSizes(fullPath, heights, { priority: "background" });
      }
    },
  };
};

// Files that failed this process's lifetime (corrupt, unsupported). Kept in
// memory only, so a restart retries them once — there are few, and a failure
// costs one read, not a retry loop: each is attempted at most once per process.
const failedPaths = new Set<string>();

type ThumbnailBackfillDeps = {
  getLoad: () => number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

const defaultDeps: ThumbnailBackfillDeps = {
  getLoad: getNormalizedLoad,
  sleep: defaultSleep,
  now: Date.now,
};

export const processThumbnailBackfill = (
  database: IndexDatabase,
  config: ThumbnailBackfillConfig,
  deps: Partial<ThumbnailBackfillDeps> = {},
): TaskRunner => {
  const { getLoad, sleep, now } = { ...defaultDeps, ...deps };
  const ctrl = createTaskController("Thumbnail backfill cancelled");
  const pace = createReadPacer(config.bytesPerSecond, now, sleep);
  let total = 0;
  let checked = 0;
  let generated = 0;
  let failed = 0;
  let description = "Starting";

  // Waits out user activity (via the controller) and a busy machine, in either
  // order: a load wait can end just as a user request starts.
  const waitForTurn = async () => {
    for (;;) {
      ctrl.checkCancelled();
      await ctrl.waitUntilResumed();
      ctrl.checkCancelled();
      if (!config.isEnabled()) {
        description = "Off (thumbnailBackfill feature flag)";
        await sleep(LOAD_POLL_MS);
        continue;
      }
      if (getLoad() <= config.maxLoad) return;
      description = "Waiting for the machine to be less busy";
      await sleep(LOAD_POLL_MS);
    }
  };

  const completion = (async () => {
    const startedAt = now();
    let readBytes = 0;
    // Paths this pass has already looked at, so a refreshed list (see
    // CANDIDATE_REFRESH_MS) resumes where it was and only adds what is new.
    const done = new Set<string>();

    for (let fresh = true; fresh;) {
      fresh = false;
      const listedAt = now();
      const candidates = await database.getThumbnailBackfillCandidates();
      total = candidates.length;

      for (const { relativePath, mimeType, sizeInBytes } of candidates) {
        if (done.has(relativePath)) continue;
        if (now() - listedAt > CANDIDATE_REFRESH_MS) {
          fresh = true;
          break;
        }
        await waitForTurn();
        description = "Generating grid thumbnails";
        done.add(relativePath);
        checked = done.size;

        const fullPath = path.join(database.storagePath, stripLeadingSlash(relativePath));
        if (failedPaths.has(fullPath)) continue;
        const work = await planThumbnailWork(fullPath, mimeType, sizeInBytes);
        if (!work) continue;

        await pace(work.readBytes);
        // The pacing sleep can span the start of a user request; yield to it.
        await waitForTurn();

        const workStartedAt = now();
        try {
          await work.run();
          generated += 1;
          readBytes += work.readBytes;
        } catch (err) {
          failedPaths.add(fullPath);
          failed += 1;
          log.debug({ err, path: relativePath }, "Thumbnail backfill failed for file");
        }
        await sleep(restAfter(now() - workStartedAt));
      }
    }

    log.info(
      {
        checked,
        total,
        generated,
        failed,
        readMB: Math.round(readBytes / 1024 / 1024),
        minutes: Math.round((now() - startedAt) / 60_000),
      },
      "Thumbnail backfill pass finished",
    );
    description = "Up to date";
    ctrl.markComplete();
  })();

  return {
    pause: ctrl.pause,
    resume: ctrl.resume,
    cancel: ctrl.cancel,
    getStatus: () =>
      Promise.resolve({
        state: ctrl.state,
        itemsProcessed: checked,
        total,
        portionComplete: total > 0 ? Math.min(1, checked / total) : undefined,
        description: `${description} (${generated} made${failed ? `, ${failed} failed` : ""})`,
      }),
    onComplete: () => completion,
  };
};
