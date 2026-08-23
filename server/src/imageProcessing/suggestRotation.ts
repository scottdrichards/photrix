import { spawn } from "child_process";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { getMirroredCachedFilePath } from "../common/cacheUtils.ts";
import { resolvePythonCommand, buildPythonProcessEnv } from "../python/pythonRuntime.ts";
import { getLogger } from "../observability/logger.ts";

const log = getLogger("suggestRotation");

export type RotationSuggestion = {
  /** Degrees to rotate the photo to level it; null when no confident suggestion exists. */
  angle: number | null;
  confidence?: number;
};

type CachedSuggestion = RotationSuggestion & { generatedAt: number };

const cachePathFor = (absoluteFilePath: string): string =>
  getMirroredCachedFilePath(absoluteFilePath, "horizon", "json");

const scriptPath = join(import.meta.dirname, "detect_horizon.py");

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
  try {
    const raw = await readFile(cachePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<CachedSuggestion>;
    if ("angle" in parsed) {
      return { angle: parsed.angle ?? null, confidence: parsed.confidence };
    }
  } catch {
    // Not cached yet — fall through to compute.
  }

  const pythonCommand = await resolvePythonCommand();
  const env = await buildPythonProcessEnv(pythonCommand);

  const result = await new Promise<RotationSuggestion>((resolve) => {
    const proc = spawn(pythonCommand, [scriptPath, absoluteFilePath], { env });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
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

  // Best-effort cache write — a failure here just means recomputing next time.
  try {
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(
      cachePath,
      JSON.stringify({ ...result, generatedAt: Date.now() } satisfies CachedSuggestion),
    );
  } catch {
    // ignore
  }

  return result;
};
