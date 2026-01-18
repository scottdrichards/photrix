import { spawn } from "child_process";
import { existsSync } from "fs";
import { stat } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { StandardHeight } from "../common/standardHeights.ts";
import { getMirroredCachePath, getHash, ensureCacheDir } from "../common/cacheUtils.ts";
import { mediaProcessingQueue, QueuePriority } from "../common/processingQueue.ts";

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "process_image.py");

type PythonInvocation = {
  command: string;
  baseArgs: string[];
};

let pythonInvocationPromise: Promise<PythonInvocation> | null = null;

const runProbe = async (
  command: string,
  args: string[],
  timeoutMs = 2_000,
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> =>
  await new Promise((resolveProbe) => {
    const process = spawn(command, args, { windowsHide: true });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      process.kill();
    }, timeoutMs);

    process.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    process.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    process.on("close", (code) => {
      clearTimeout(timer);
      resolveProbe({
        ok: code === 0 && !timedOut,
        stdout,
        stderr,
        exitCode: code,
        timedOut,
      });
    });

    process.on("error", (error) => {
      clearTimeout(timer);
      resolveProbe({
        ok: false,
        stdout,
        stderr: `${stderr}${stderr ? "\n" : ""}${error.message}`,
        exitCode: null,
        timedOut,
      });
    });
  });

const isWindowsStorePythonShim = (sysExecutable: string): boolean =>
  /\\AppData\\Local\\Microsoft\\WindowsApps\\python\.exe$/i.test(sysExecutable.trim());

const resolvePythonInvocation = async (): Promise<PythonInvocation> => {
  if (pythonInvocationPromise) {
    return await pythonInvocationPromise;
  }

  pythonInvocationPromise = (async () => {
    const configured = process.env.PHOTRIX_PYTHON?.trim();
    if (configured) {
      return { command: configured, baseArgs: [] };
    }

    const probeCode = "import sys; print(sys.executable)";

    const candidates: PythonInvocation[] =
      process.platform === "win32"
        ? [
            { command: "py", baseArgs: [] },
            { command: "python", baseArgs: [] },
          ]
        : [
            { command: "python3", baseArgs: [] },
            { command: "python", baseArgs: [] },
          ];

    for (const candidate of candidates) {
      const probe = await runProbe(candidate.command, [...candidate.baseArgs, "-c", probeCode]);
      if (!probe.ok) {
        continue;
      }

      const sysExecutable = probe.stdout.trim();
      if (process.platform === "win32" && candidate.command === "python" && isWindowsStorePythonShim(sysExecutable)) {
        // This commonly hangs or redirects to the Store; skip it.
        continue;
      }

      return candidate;
    }

    const guidance =
      process.platform === "win32"
        ? "Install Python from python.org (or via winget) so the `py` launcher is available, or set PHOTRIX_PYTHON to your python.exe. Also ensure App Execution Aliases for python.exe are disabled if you only have the Windows Store shim."
        : "Install Python 3 (python3) or set PHOTRIX_PYTHON to your python executable.";

    throw new Error(`Python is required for image conversion but was not found. ${guidance}`);
  })();

  return await pythonInvocationPromise;
};

export class ImageConversionError extends Error {
  constructor(
    message: string,
    readonly inputPath: string,
    readonly stderr: string,
    readonly exitCode?: number,
  ) {
    super(message);
    this.name = "ImageConversionError";
  }
}


const generateImage = async (
  inputPath: string,
  outputs: Array<{ path: string; height: StandardHeight }>,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const start = performance.now();
    const args = [
      scriptPath,
      inputPath,
      "--outputs",
      JSON.stringify(outputs.map(o => ({
        path: o.path,
        height: o.height === 'original' ? null : o.height
      })))
    ];

    // Resolve a real python executable (Windows Store shim `python.exe` will not work).
    void resolvePythonInvocation().then(({ command, baseArgs }) => {
      const process = spawn(command, [...baseArgs, ...args], { windowsHide: true });

      let stderr = "";

      process.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      process.on("close", (code) => {
        const duration = performance.now() - start;
        console.log(
          `[ImageCache] Image processing completed in ${duration.toFixed(2)}ms for ${inputPath} and outputs: ${outputs.map(o => o.height).join(", ")}`,
        );
        if (code === 0) {
          resolve();
          return;
        }

        const normalizedError = stderr.trim() || `Python exited with code ${code ?? "unknown"}`;
        const isCorrupt = /unexpected end of file/i.test(normalizedError) || /invalid input/i.test(normalizedError);
        const isMissingDependency =
          /modulenotfounderror/i.test(normalizedError) || /no module named/i.test(normalizedError);

        const baseMessage = isCorrupt
          ? `Corrupt or unreadable image ${inputPath}: ${normalizedError}`
          : `Image conversion failed for ${inputPath}: ${normalizedError}`;

        const message = isMissingDependency
          ? `${baseMessage}\n\nPython dependencies may be missing. Try: pip install -r server/src/imageProcessing/requirements.txt`
          : baseMessage;

        console.error(`[ImageCache] Python script failed (${code ?? "unknown"}): ${baseMessage}`);
        reject(new ImageConversionError(message, inputPath, normalizedError, code ?? undefined));
      });

      process.on("error", (err) => {
        console.error(`[ImageCache] Failed to start python process: ${err.message}`);
        reject(err);
      });
    }).catch((error) => {
      reject(error);
    });
  });

/**
 * Creates a converted image at the specified height, caching the result.
 * @returns Path of converted image
 */
export const convertImage = async (
  filePath: string,
  height: StandardHeight = 2160,
  opts?: { priority?: QueuePriority },
): Promise<string> => {
  const modifiedTimeMs = (await stat(filePath)).mtimeMs;
  const hash = getHash(filePath, modifiedTimeMs);
  const cachedPath = getMirroredCachePath(filePath, hash, height, "jpg");

  if (existsSync(cachedPath)) {
    return cachedPath;
  }

  await mediaProcessingQueue.enqueue(
    async () => {
      await ensureCacheDir(cachedPath);
      console.log(`[ImageCache] Generating ${height} for ${filePath}`);
      await generateImage(filePath, [{ path: cachedPath, height }]);
    },
    opts?.priority,
  );
  return cachedPath;
};

export const convertImageToMultipleSizes = async (
  filePath: string,
  heights: StandardHeight[],
  opts?: { priority?: QueuePriority },
): Promise<void> => {
  const modifiedTimeMs = (await stat(filePath)).mtimeMs;
  const hash = getHash(filePath, modifiedTimeMs);
  
  const outputs = heights
    .map(height => ({
      height,
      path: getMirroredCachePath(filePath, hash, height, "jpg")
    }))
    .filter(o => !existsSync(o.path));

  if (outputs.length === 0) {
    return;
  }

  await mediaProcessingQueue.enqueue(
    async () => {
      // Ensure all cache directories exist
      await Promise.all(outputs.map(o => ensureCacheDir(o.path)));
      console.log(
        `[ImageCache] Generating sizes ${outputs.map(o => o.height).join(", ")} for ${filePath}`,
      );
      await generateImage(filePath, outputs);
    },
    opts?.priority,
  );
};
