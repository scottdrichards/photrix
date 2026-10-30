import { spawn } from "child_process";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname } from "path";
import { fileURLToPath } from "url";
import { getMirroredCachedFilePath } from "../common/cacheUtils.ts";
import { resolvePythonCommand, buildPythonProcessEnv } from "../python/pythonRuntime.ts";
import { getLogger } from "../observability/logger.ts";
import { attempt, attemptSync, isNotFound } from "../common/result.ts";
import { logFailure } from "../common/logFailure.ts";

const log = getLogger("suggestRotation");

type RotationSuggestion = {
  /** Degrees to rotate the photo to level it; null when no confident suggestion exists. */
  angle: number | null;
  confidence?: number;
};

type CachedSuggestion = RotationSuggestion & { generatedAt: number };

const cachePathFor = (absoluteFilePath: string): string =>
  getMirroredCachedFilePath(absoluteFilePath, "horizon", "json");

const scriptPath = fileURLToPath(new URL("detect_horizon.py", import.meta.url));

/**
 * Feedback #66's auto-straighten suggestion — see detect_horizon.py's module
 * doc comment for the research behind why this is a Hough-line vote rather
 * than the "frequency/depth map" heuristic originally proposed, and why it's
 * confidence-gated to `angle: null` (never a forced/guessed rotation) on
 * anything short of a clear dominant near-level/plumb line.
 *
 * Result is cached per-file (same mirrored-cache pattern as photoCaptionCache
 * and the thumbnail/HLS caches) — this is a real ~1-4s CPU cost (Canny +
 * Hough over a downscaled frame), not something to pay on every editor open.
 */
export const suggestRotation = async (
  absoluteFilePath: string,
): Promise<RotationSuggestion> => {
  const cachePath = cachePathFor(absoluteFilePath);
  const raw = await attempt(readFile(cachePath, "utf-8"));
  if (!raw.ok && !isNotFound(raw.error)) {
    log.warn({ err: raw.error }, "Could not read a cached rotation suggestion; recomputing");
  }
  const parsed = raw.ok ? attemptSync(() => JSON.parse(raw.value) as Partial<CachedSuggestion>) : null;
  if (parsed && !parsed.ok) log.warn({ err: parsed.error }, "Corrupt cached rotation suggestion; recomputing");
  if (parsed?.ok && "angle" in parsed.value) {
    return { angle: parsed.value.angle ?? null, confidence: parsed.value.confidence };
  }

  const pythonCommand = await resolvePythonCommand();
  const env = await buildPythonProcessEnv(pythonCommand);

  const result = await new Promise<RotationSuggestion>((resolve) => {
    const proc = spawn(pythonCommand, [scriptPath, absoluteFilePath], { env });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("close", (code) => {
      if (code !== 0) {
        log.warn({ code, stderr }, "detect_horizon.py exited non-zero");
        resolve({ angle: null });
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim()) as {
          angle: number | null;
          confidence?: number;
        };
        resolve({ angle: parsed.angle ?? null, confidence: parsed.confidence });
      } catch (err) {
        log.warn({ err, stdout }, "Failed to parse detect_horizon.py output");
        resolve({ angle: null });
      }
    });
    proc.on("error", (err) => {
      log.warn({ err }, "Failed to spawn detect_horizon.py");
      resolve({ angle: null });
    });
  });

  // A failed cache write only means recomputing next time.
  await mkdir(dirname(cachePath), { recursive: true })
    .then(() =>
      writeFile(
        cachePath,
        JSON.stringify({ ...result, generatedAt: Date.now() } satisfies CachedSuggestion),
      ),
    )
    .catch(logFailure(log, "Could not cache a rotation suggestion"));

  return result;
};
