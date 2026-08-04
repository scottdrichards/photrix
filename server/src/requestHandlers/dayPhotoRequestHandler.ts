import type http from "node:http";
import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { join } from "node:path";
import { CACHE_DIR } from "../common/cacheUtils.ts";
import { getLogger } from "../observability/logger.ts";

const log = getLogger("dayPhotoRequestHandler");

// Backs the HA Calendar dashboard's per-day background image (see
// ha_calendar_day_photos memory / server/scripts/dayPhoto). Home Assistant
// pulls this endpoint nightly per date; photrix has no knowledge of HA
// beyond serving "the representative photo for this date" as a JPEG.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_PHOTO_DIR = join(CACHE_DIR, "day-photos");
const GENERATE_SCRIPT = join(
  process.cwd(),
  "scripts",
  "dayPhoto",
  "generate_day_photos.py",
);
const GENERATE_TIMEOUT_MS = 60_000;

const runGenerateScript = (date: string): Promise<void> =>
  new Promise((resolvePromise, rejectPromise) => {
    const pythonBin = process.env.PHOTRIX_PYTHON?.trim() || "python3";
    const child = spawn(pythonBin, [GENERATE_SCRIPT, date, date], {
      timeout: GENERATE_TIMEOUT_MS,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`generate_day_photos.py exited ${code}: ${stderr}`));
      }
    });
  });

/**
 * GET /api/day-photo/:date (date = YYYY-MM-DD). Serves a cached JPEG of that
 * day's representative photo, generating it on first request. 404 if the
 * date has no photos.
 */
export const dayPhotoRequestHandler = async (
  req: http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
  res: http.ServerResponse,
): Promise<void> => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const date = url.pathname.replace(/^\/api\/day-photo\/?/, "");

  if (!DATE_RE.test(date)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "date must be YYYY-MM-DD" }));
    return;
  }

  const jpegPath = join(DAY_PHOTO_DIR, `${date}.jpg`);

  if (!existsSync(jpegPath)) {
    try {
      await runGenerateScript(date);
    } catch (error) {
      log.error({ err: error, date }, "day-photo generation failed");
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Photo generation failed" }));
      return;
    }
  }

  if (!existsSync(jpegPath)) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "No photos for this date" }));
    return;
  }

  res.writeHead(200, {
    "Content-Type": "image/jpeg",
    "Cache-Control": "public, max-age=86400",
  });
  createReadStream(jpegPath).pipe(res);
};
