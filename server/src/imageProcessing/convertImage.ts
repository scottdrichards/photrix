import { spawn } from "child_process";
import { existsSync } from "fs";
import { stat } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { StandardHeight } from "../common/standardHeights.ts";
import { getCachedFilePath as getSharedCachedFilePath, getHash } from "../common/cacheUtils.ts";
import { mediaProcessingQueue, QueuePriority } from "../common/processingQueue.ts";

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "process_image.py");
const pythonPath = "python";

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

    const process = spawn(pythonPath, args);

    let stderr = "";

    process.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    process.on("close", (code) => {
      const duration = performance.now() - start;
      console.log(`[ImageCache] Image processing completed in ${duration.toFixed(2)}ms for ${inputPath} and outputs: ${outputs.map(o => o.height).join(", ")}`);
      if (code === 0) {
        resolve();
      } else {
        const normalizedError = stderr.trim() || `Python exited with code ${code ?? "unknown"}`;
        const isCorrupt = /unexpected end of file/i.test(normalizedError) || /invalid input/i.test(normalizedError);
        const message = isCorrupt
          ? `Corrupt or unreadable image ${inputPath}: ${normalizedError}`
          : `Image conversion failed for ${inputPath}: ${normalizedError}`;

        console.error(`[ImageCache] Python script failed (${code ?? "unknown"}): ${message}`);
        reject(new ImageConversionError(message, inputPath, normalizedError, code ?? undefined));
      }
    });

    process.on("error", (err) => {
      console.error(`[ImageCache] Failed to start python process: ${err.message}`);
      reject(err);
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
  const cachedPath = getSharedCachedFilePath(hash, height, "jpg");

  if (existsSync(cachedPath)) {
    return cachedPath;
  }

  await mediaProcessingQueue.enqueue(
    async () => {
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
      path: getSharedCachedFilePath(hash, height, "jpg")
    }))
    .filter(o => !existsSync(o.path));

  if (outputs.length === 0) {
    return;
  }

  await mediaProcessingQueue.enqueue(
    async () => {
      console.log(
        `[ImageCache] Generating sizes ${outputs.map(o => o.height).join(", ")} for ${filePath}`,
      );
      await generateImage(filePath, outputs);
    },
    opts?.priority,
  );
};
