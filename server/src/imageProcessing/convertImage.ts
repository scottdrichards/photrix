import { spawn } from "child_process";
import { stat, mkdir, access } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { StandardHeight } from "../common/standardHeights.ts";
import { getMirroredCachedFilePath } from "../common/cacheUtils.ts";
import { type ConversionPriority } from "../common/conversionPriority.ts";
import { measureOperation } from "../observability/requestTrace.ts";

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "process_image.py");

// Helper function to ensure cache directory exists
const ensureCacheDir = async (filePath: string): Promise<void> => {
  await mkdir(dirname(filePath), { recursive: true });
};

type PythonInvocation = {
  command: string;
  baseArgs: string[];
};

let pythonInvocationPromise: Promise<PythonInvocation> | null = null;

const runProbe = async (
  command: string,
  args: string[],
  timeoutMs = 2_000,
): Promise<{
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}> =>
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
      const probe = await runProbe(candidate.command, [
        ...candidate.baseArgs,
        "-c",
        probeCode,
      ]);
      if (!probe.ok) {
        continue;
      }

      const sysExecutable = probe.stdout.trim();
      if (
        process.platform === "win32" &&
        candidate.command === "python" &&
        isWindowsStorePythonShim(sysExecutable)
      ) {
        // This commonly hangs or redirects to the Store; skip it.
        continue;
      }

      return candidate;
    }

    const guidance =
      process.platform === "win32"
        ? "Install Python from python.org (or via winget) so the `py` launcher is available, or set PHOTRIX_PYTHON to your python.exe. Also ensure App Execution Aliases for python.exe are disabled if you only have the Windows Store shim."
        : "Install Python 3 (python3) or set PHOTRIX_PYTHON to your python executable.";

    throw new Error(
      `Python is required for image conversion but was not found. ${guidance}`,
    );
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
  measureOperation(
    "pythonImageProcess",
    () =>
      new Promise((resolve, reject) => {
        const args = [
          scriptPath,
          inputPath,
          "--outputs",
          JSON.stringify(
            outputs.map((o) => ({
              path: o.path,
              height: o.height === "original" ? null : o.height,
            })),
          ),
        ];

        // Resolve a real python executable (Windows Store shim `python.exe` will not work).
        void resolvePythonInvocation()
          .then(({ command, baseArgs }) => {
            const process = spawn(command, [...baseArgs, ...args], { windowsHide: true });

            let stderr = "";

            process.stderr.on("data", (data) => {
              stderr += data.toString();
            });

            process.on("close", (code) => {
              if (code === 0) {
                resolve();
                return;
              }

              const normalizedError =
                stderr.trim() || `Python exited with code ${code ?? "unknown"}`;
              const isCorrupt =
                /unexpected end of file/i.test(normalizedError) ||
                /invalid input/i.test(normalizedError);
              const isMissingDependency =
                /modulenotfounderror/i.test(normalizedError) ||
                /no module named/i.test(normalizedError);

              const baseMessage = isCorrupt
                ? `Corrupt or unreadable image ${inputPath}: ${normalizedError}`
                : `Image conversion failed for ${inputPath}: ${normalizedError}`;

              const message = isMissingDependency
                ? `${baseMessage}\n\nPython dependencies may be missing. Try: pip install -r server/src/imageProcessing/requirements.txt`
                : baseMessage;

              console.error(
                `[ImageCache] Python script failed (${code ?? "unknown"}): ${baseMessage}`,
              );
              reject(
                new ImageConversionError(
                  message,
                  inputPath,
                  normalizedError,
                  code ?? undefined,
                ),
              );
            });

            process.on("error", (err) => {
              console.error(`[ImageCache] Failed to start python process: ${err.message}`);
              reject(err);
            });
          })
          .catch((error) => {
            reject(error);
          });
      }),
    {
      category: "conversion",
      detail: outputs.map((output) => String(output.height)).join(","),
      logWithoutRequest: true,
    },
  );

/**
 * Creates a converted image at the specified height, caching the result.
 * @returns Path of converted image
 */
export const convertImage = async (
  filePath: string,
  height: StandardHeight = 2160,
  opts?: { priority?: ConversionPriority },
): Promise<string> => {
  void opts;
  await stat(filePath);
  const cachedPath = getMirroredCachedFilePath(filePath, height, "jpg");

  const cachedExists = await access(cachedPath).then(() => true, () => false);
  if (cachedExists) {
    return cachedPath;
  }

  await ensureCacheDir(cachedPath);
  console.log(`[ImageCache] Generating ${height} for ${filePath}`);
  await measureOperation(
    "convertImage",
    () => generateImage(filePath, [{ path: cachedPath, height }]),
    { category: "conversion", detail: String(height), logWithoutRequest: true },
  );
  return cachedPath;
};

export const convertImageToMultipleSizes = async (
  filePath: string,
  heights: StandardHeight[],
  opts?: { priority?: ConversionPriority },
): Promise<void> => {
  void opts;
  await stat(filePath);

  const existChecks = await Promise.all(
    heights.map(async (height) => {
      const p = getMirroredCachedFilePath(filePath, height, "jpg");
      const exists = await access(p).then(() => true, () => false);
      return { height, path: p, exists };
    }),
  );
  const outputs = existChecks.filter((o) => !o.exists);

  if (outputs.length === 0) {
    return;
  }

  await Promise.all(outputs.map((o) => ensureCacheDir(o.path)));
  console.log(
    `[ImageCache] Generating sizes ${outputs.map((o) => o.height).join(", ")} for ${filePath}`,
  );
  await measureOperation(
    "convertImageToMultipleSizes",
    () => generateImage(filePath, outputs),
    {
      category: "conversion",
      detail: outputs.map((output) => String(output.height)).join(","),
      logWithoutRequest: true,
    },
  );
};
