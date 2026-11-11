import type http from "node:http";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { getLogger } from "../observability/logger.ts";

const log = getLogger("screensaverRequestHandler");

// Backs the Home Assistant wall-calendar screensaver. Returns a weighted-random
// set of "top photos" from the last year (recency x stars x family-faces); the
// HA side caches the transcoded JPEGs locally and crossfades them. Selection
// lives in scripts/dayPhoto/screensaver_pick.py (read-only sqlite), mirroring
// the day-photo endpoint. Full-auth only (shareLink: "forbidden").
const PICK_SCRIPT = join(process.cwd(), "scripts", "dayPhoto", "screensaver_pick.py");
const PICK_TIMEOUT_MS = 60_000;

const runPick = (count: string, windowDays: string, env: NodeJS.ProcessEnv): Promise<string> =>
  new Promise((resolvePromise, rejectPromise) => {
    const pythonBin = process.env.PHOTRIX_PYTHON?.trim() || "python3";
    const child = spawn(pythonBin, [PICK_SCRIPT, count, windowDays], {
      timeout: PICK_TIMEOUT_MS,
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(stdout);
      else rejectPromise(new Error(`screensaver_pick.py exited ${code}: ${stderr}`));
    });
  });

/**
 * GET /api/screensaver?count=N&window=DAYS&rec=R&star=S&fam=F
 * Returns JSON { count, window_days, weights, pool, photos: [{path,date,rating,people,weight}] }.
 * The weight knobs (rec/star/fam) are optional and let the display be tuned
 * without a redeploy.
 */
export const screensaverRequestHandler = async (
  req: http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
  res: http.ServerResponse,
): Promise<void> => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const count = String(Math.max(1, Math.min(Number(url.searchParams.get("count")) || 60, 400)));
  const windowDays = String(Math.max(1, Math.min(Number(url.searchParams.get("window")) || 365, 3650)));

  const env: NodeJS.ProcessEnv = { ...process.env };
  const rec = url.searchParams.get("rec");
  const star = url.searchParams.get("star");
  const fam = url.searchParams.get("fam");
  if (rec !== null && Number.isFinite(Number(rec))) env.PHOTRIX_SS_REC = rec;
  if (star !== null && Number.isFinite(Number(star))) env.PHOTRIX_SS_STAR = star;
  if (fam !== null && Number.isFinite(Number(fam))) env.PHOTRIX_SS_FAM = fam;

  try {
    const out = await runPick(count, windowDays, env);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(out);
  } catch (error) {
    log.error({ err: error }, "screensaver pick failed");
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "screensaver pick failed" }));
  }
};
