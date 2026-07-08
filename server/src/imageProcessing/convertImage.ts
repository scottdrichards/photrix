import { spawn } from "child_process";
import { stat, mkdir, access } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { StandardHeight } from "../common/standardHeights.ts";
import { getMirroredCachedFilePath } from "../common/cacheUtils.ts";
import { type ConversionPriority } from "../common/conversionPriority.ts";
import { bindChildProcessAbort } from "../common/abortableChildProcess.ts";
import { scheduleMediaConversion } from "../common/mediaConversionScheduler.ts";
import { createAbortError, getRequestAbortSignal } from "../common/requestAbort.ts";
import { getLogger } from "../observability/logger.ts";
const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "process_image.py");

const log = getLogger("convertImage");

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

// Converted images are emitted as WebP: ~30% smaller than JPEG at matching
// quality with universal modern-browser support. process_image.py picks the
// encoder from the output file extension, so the extension and content type must
// stay in sync — both are derived from here.
export const IMAGE_OUTPUT_EXTENSION = "webp";
export const IMAGE_OUTPUT_CONTENT_TYPE = "image/webp";

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

/**
 * Crop region expressed as normalized top-left fractions (0..1) of the
 * EXIF-oriented source image.
 */
export type CropBox = { x: number; y: number; width: number; height: number };

const generateImageUnthrottled = async (
  inputPath: string,
  outputs: Array<{ path: string; height: StandardHeight; crop?: CropBox }>,
  signal?: AbortSignal,
): Promise<void> => {
  const args = [
    scriptPath,
    inputPath,
    "--outputs",
    JSON.stringify(
      outputs.map((o) => ({
        path: o.path,
        height: o.height === "original" ? null : o.height,
        ...(o.crop
          ? { crop: [o.crop.x, o.crop.y, o.crop.width, o.crop.height] }
          : {}),
      })),
    ),
  ];

  // Resolve a real python executable (Windows Store shim `python.exe` will not work).
  return new Promise((resolve, reject) => {
    void resolvePythonInvocation()
      .then(({ command, baseArgs }) => {
        const process = spawn(command, [...baseArgs, ...args], { windowsHide: true });
        const abortBinding = bindChildProcessAbort(process, signal);

        let stderr = "";

        process.stderr.on("data", (data) => {
          stderr += data.toString();
        });

        process.on("close", (code) => {
          abortBinding.cleanup();
          if (abortBinding.wasAborted()) {
            reject(createAbortError());
            return;
          }
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

          log.error(
            { inputPath, exitCode: code, stderr: normalizedError },
            "Image conversion python script failed",
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
          abortBinding.cleanup();
          if (abortBinding.wasAborted()) {
            reject(createAbortError());
            return;
          }
          log.error({ err, inputPath }, "Failed to start image conversion python process");
          reject(err);
        });
      })
      .catch((error) => {
        reject(error);
      });
  });
};

const generateImage = async (
  inputPath: string,
  outputs: Array<{ path: string; height: StandardHeight; crop?: CropBox }>,
): Promise<void> => {
  const key = outputs
    .map((output) => output.path)
    .sort()
    .join("\n");
  await scheduleMediaConversion(`image:${key}`, async (signal) => {
    const missingOutputs = await Promise.all(
      outputs.map(async (output) => ({
        ...output,
        exists: await access(output.path).then(
          () => true,
          () => false,
        ),
      })),
    );
    const uncachedOutputs = missingOutputs.filter((output) => !output.exists);
    if (uncachedOutputs.length === 0) {
      return;
    }
    await generateImageUnthrottled(inputPath, uncachedOutputs, signal);
  }, {
    signal: getRequestAbortSignal(),
  });
};

/**
 * Creates a converted image at the specified height, caching the result.
 * @returns Path of converted image
 */
export const convertImage = async (
  filePath: string,
  height: StandardHeight = 2160,
  _opts?: { priority?: ConversionPriority },
): Promise<string> => {
  await stat(filePath);
  const cachedPath = getMirroredCachedFilePath(filePath, height, IMAGE_OUTPUT_EXTENSION);

  const cachedExists = await access(cachedPath).then(
    () => true,
    () => false,
  );
  if (cachedExists) {
    return cachedPath;
  }

  await ensureCacheDir(cachedPath);
  await generateImage(filePath, [{ path: cachedPath, height }]);
  return cachedPath;
};

/** Rounds a fraction to 5 decimals so near-identical crops share a cache entry. */
const cropToken = (crop: CropBox): string => {
  const q = (n: number) => Math.round(clamp01(n) * 1e5).toString();
  return `crop_${q(crop.x)}_${q(crop.y)}_${q(crop.width)}_${q(crop.height)}`;
};

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/**
 * Creates a converted image cropped to `crop` (normalized top-left fractions of
 * the EXIF-oriented image) and resized so its longest side is at most `height`,
 * caching the result. The crop is applied before the resize, so a small crop is
 * served at higher effective resolution (and smaller file size) than cropping a
 * pre-scaled image would allow.
 * @returns Path of converted image
 */
export const convertImageCrop = async (
  filePath: string,
  crop: CropBox,
  height: StandardHeight = 2160,
  _opts?: { priority?: ConversionPriority },
): Promise<string> => {
  await stat(filePath);
  const cachedPath = getMirroredCachedFilePath(
    filePath,
    `${height}.${cropToken(crop)}`,
    IMAGE_OUTPUT_EXTENSION,
  );

  const cachedExists = await access(cachedPath).then(
    () => true,
    () => false,
  );
  if (cachedExists) {
    return cachedPath;
  }

  await ensureCacheDir(cachedPath);
  await generateImage(filePath, [{ path: cachedPath, height, crop }]);
  return cachedPath;
};

export const convertImageToMultipleSizes = async (
  filePath: string,
  heights: StandardHeight[],
  _opts?: { priority?: ConversionPriority },
): Promise<void> => {
  await stat(filePath);

  const existChecks = await Promise.all(
    heights.map(async (height) => {
      const p = getMirroredCachedFilePath(filePath, height, IMAGE_OUTPUT_EXTENSION);
      const exists = await access(p).then(
        () => true,
        () => false,
      );
      return { height, path: p, exists };
    }),
  );
  const outputs = existChecks.filter((o) => !o.exists);

  if (outputs.length === 0) {
    return;
  }

  await Promise.all(outputs.map((o) => ensureCacheDir(o.path)));
  await generateImage(filePath, outputs);
};
