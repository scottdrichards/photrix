import { access } from "node:fs/promises";
import path from "node:path";
import { getMirroredCachedFilePath } from "../common/cacheUtils.ts";
import type { StandardHeight } from "../common/standardHeights.ts";
import { stripLeadingSlash } from "../common/stripLeadingSlash.ts";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { getLogger } from "../observability/logger.ts";
import { createTaskController } from "../taskOrchestrator/taskController.ts";
import type { TaskRunner } from "../taskOrchestrator/taskOrchestrator.ts";
import { generateVideoThumbnail } from "../videoProcessing/videoUtils.ts";
import { convertImageToMultipleSizes, IMAGE_OUTPUT_EXTENSION } from "./convertImage.ts";
import { convertEmbeddedThumbnail } from "./embeddedThumbnail.ts";

const log = getLogger("thumbnailBackfill");

// ---------------------------------------------------------------------------
// Overnight grid-thumbnail backfill.
//
// Grid tiles are otherwise generated on first view, so scrolling into a folder
// nobody has opened before decodes every original off the media share while
// the user waits (3–7 s a screenful, measured 2026-10-20). This pass makes the
// same files ahead of time: the 160 micro tile and the 320 tile for every
// photo, and the 320 frame for every video.
//
// Reading the whole library is ~730 GB off the NAS, so the pass is fenced in
// three ways:
//   - an hour window (default 1–7 AM), so it never runs while people are up;
//   - a byte-rate cap on source reads (default 25 MB/s, a fifth of gigabit);
//   - one file at a time, pausing between files whenever the orchestrator sees
//     user activity, so a live request never queues behind it for long.
//
// What still needs doing is read off the cache on disk rather than a DB
// column: a cache entry that is deleted (a source file changed, a manual
// sweep) is simply regenerated on the next night's pass. The thumbnails it
// makes are exempt from LRU eviction (see cacheEviction.ts), or the 10 GB
// budget would slowly undo the work.
// ---------------------------------------------------------------------------

/** The two grid sizes a photo tile requests: `representation=micro`, then 320. */
const MICRO_HEIGHT = 160;
const TILE_HEIGHT = 320;

/** A video thumbnail is one frame near the start; ffmpeg reads far less than the file. */
const VIDEO_THUMBNAIL_READ_ESTIMATE_BYTES = 8 * 1024 * 1024;
/** Used when the index has no size for a photo yet. */
const DEFAULT_IMAGE_READ_ESTIMATE_BYTES = 5 * 1024 * 1024;

const DEFAULT_HOURS = "1-7";
const DEFAULT_MB_PER_SECOND = 25;

export type HourWindow = { startHour: number; endHour: number };

export type ThumbnailBackfillConfig = {
  enabled: boolean;
  /** null means any hour. Hours are [start, end) and may wrap past midnight. */
  window: HourWindow | null;
  /** IANA zone the window is read in; undefined means the process's local time. */
  timeZone: string | undefined;
  bytesPerSecond: number;
};

/**
 * Parses "1-7" (1 AM until 7 AM) or "22-6" (wrapping midnight). "0-24" means
 * any hour. Returns undefined when the value is malformed.
 */
export const parseHourWindow = (raw: string): HourWindow | null | undefined => {
  const match = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(raw);
  if (!match) return undefined;
  const startHour = Number(match[1]);
  const endHour = Number(match[2]);
  if (startHour > 23 || endHour > 24 || startHour === endHour) return undefined;
  if (startHour === 0 && endHour === 24) return null;
  return { startHour, endHour: endHour % 24 };
};

export const readThumbnailBackfillConfig = (
  env: NodeJS.ProcessEnv = process.env,
): ThumbnailBackfillConfig => {
  const rawHours = env.PHOTRIX_THUMBNAIL_BACKFILL_HOURS?.trim() || DEFAULT_HOURS;
  let window = parseHourWindow(rawHours);
  if (window === undefined) {
    log.warn(
      { value: rawHours },
      "Invalid PHOTRIX_THUMBNAIL_BACKFILL_HOURS; using default",
    );
    window = parseHourWindow(DEFAULT_HOURS)!;
  }

  const timeZone = env.PHOTRIX_THUMBNAIL_BACKFILL_TZ?.trim() || undefined;
  if (timeZone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone });
    } catch {
      log.warn({ timeZone }, "Invalid PHOTRIX_THUMBNAIL_BACKFILL_TZ; using local time");
      return readThumbnailBackfillConfig({ ...env, PHOTRIX_THUMBNAIL_BACKFILL_TZ: "" });
    }
  }

  const mbPerSecond = Number(env.PHOTRIX_THUMBNAIL_BACKFILL_MB_PER_SEC);
  return {
    enabled: env.PHOTRIX_THUMBNAIL_BACKFILL !== "0",
    window,
    timeZone,
    bytesPerSecond:
      (Number.isFinite(mbPerSecond) && mbPerSecond > 0
        ? mbPerSecond
        : DEFAULT_MB_PER_SECOND) *
      1024 *
      1024,
  };
};

/** Minutes since local midnight in `timeZone` (or process-local time). */
const minuteOfDay = (date: Date, timeZone: string | undefined): number => {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
    timeZone,
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return value("hour") * 60 + value("minute");
};

export const isWithinWindow = (
  date: Date,
  window: HourWindow | null,
  timeZone: string | undefined,
): boolean => {
  if (!window) return true;
  const hour = Math.floor(minuteOfDay(date, timeZone) / 60);
  return window.startHour < window.endHour
    ? hour >= window.startHour && hour < window.endHour
    : hour >= window.startHour || hour < window.endHour;
};

/**
 * Milliseconds until the window next opens, strictly in the future (so a call
 * made right at the opening minute points at tomorrow's). Across a DST change
 * this can be an hour off; the pass re-checks the window when it starts, and
 * the schedule re-arms from the new local time, so it corrects itself.
 */
export const msUntilWindowOpens = (
  date: Date,
  window: HourWindow,
  timeZone: string | undefined,
): number => {
  const minutesNow = minuteOfDay(date, timeZone);
  let minutes = (window.startHour * 60 - minutesNow + 24 * 60) % (24 * 60);
  if (minutes === 0) minutes = 24 * 60;
  return minutes * 60_000 - date.getSeconds() * 1000 - date.getMilliseconds();
};

/**
 * Calls `ensure` each time the window opens. The pass itself also runs whenever
 * the pipeline is (re)queued, but outside the window it returns immediately,
 * so this is what actually starts it each night. Returns a stop function.
 */
export const startThumbnailBackfillSchedule = (
  ensure: () => void,
  config: ThumbnailBackfillConfig = readThumbnailBackfillConfig(),
): (() => void) => {
  const { window } = config;
  if (!config.enabled || !window) return () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    timer = setTimeout(
      () => {
        ensure();
        arm();
      },
      msUntilWindowOpens(new Date(), window, config.timeZone),
    );
    timer.unref?.();
  };
  arm();
  return () => clearTimeout(timer);
};

/**
 * Paces source reads to `bytesPerSecond`: each call waits until the bytes the
 * previous calls were charged for have "drained", then charges its own.
 */
export const createReadPacer = (
  bytesPerSecond: number,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
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
// costs one read, not a retry loop: each is attempted at most once a night.
const failedPaths = new Set<string>();

export const processThumbnailBackfill = (
  database: IndexDatabase,
  config: ThumbnailBackfillConfig = readThumbnailBackfillConfig(),
  now: () => Date = () => new Date(),
): TaskRunner => {
  const ctrl = createTaskController("Thumbnail backfill cancelled");
  const pace = createReadPacer(config.bytesPerSecond);
  const inWindow = () => isWithinWindow(now(), config.window, config.timeZone);
  let total = 0;
  let checked = 0;
  let generated = 0;
  let failed = 0;
  let description = "Starting";

  const completion = (async () => {
    if (!config.enabled || !inWindow()) {
      description = config.enabled ? "Waiting for the overnight window" : "Disabled";
      ctrl.markComplete();
      return;
    }

    const candidates = await database.getThumbnailBackfillCandidates();
    total = candidates.length;
    description = "Generating grid thumbnails";
    const startedAt = Date.now();
    let readBytes = 0;

    for (const { relativePath, mimeType, sizeInBytes } of candidates) {
      ctrl.checkCancelled();
      await ctrl.waitUntilResumed();
      ctrl.checkCancelled();
      if (!inWindow()) {
        description = "Window closed; resumes tomorrow night";
        break;
      }
      checked += 1;

      const fullPath = path.join(database.storagePath, stripLeadingSlash(relativePath));
      if (failedPaths.has(fullPath)) continue;
      const work = await planThumbnailWork(fullPath, mimeType, sizeInBytes);
      if (!work) continue;

      await pace(work.readBytes);
      // The pacing sleep can span the start of a user request; yield to it.
      await ctrl.waitUntilResumed();
      ctrl.checkCancelled();

      try {
        await work.run();
        generated += 1;
        readBytes += work.readBytes;
      } catch (err) {
        failedPaths.add(fullPath);
        failed += 1;
        log.debug({ err, path: relativePath }, "Thumbnail backfill failed for file");
      }
    }

    log.info(
      {
        checked,
        total,
        generated,
        failed,
        readMB: Math.round(readBytes / 1024 / 1024),
        minutes: Math.round((Date.now() - startedAt) / 60_000),
      },
      "Thumbnail backfill pass finished",
    );
    if (checked === total) description = "Up to date";
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
        portionComplete: total > 0 ? checked / total : undefined,
        description: `${description} (${generated} made${failed ? `, ${failed} failed` : ""})`,
      }),
    onComplete: () => completion,
  };
};
