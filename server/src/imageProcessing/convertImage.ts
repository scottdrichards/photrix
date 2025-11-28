import { spawn } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdirSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

export const standardDimensions = [
  300, //thumbnail
  2048, //large
  'original', //original
 ] as const;

export type ImageSize = typeof standardDimensions[number];

const cacheDir = join(process.cwd(), ".cache", "photrix");
const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "process_image.py");
const pythonPath = "python";

// Initialize cache directory
if (!existsSync(cacheDir)) {
  mkdirSync(cacheDir, { recursive: true });
}
console.log(`[ImageCache] Initialized at ${cacheDir}`);

const getHash = (filePath: string): string =>
  createHash("md5").update(filePath).digest("hex");

const getCachedFilePath = (hash: string, size: ImageSize) =>
  join(cacheDir, `${hash}.${size}.jpeg`);

const generateImage = async (
  inputPath: string,
  outputPath: string,
  size: ImageSize,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const args = [
      scriptPath,
      inputPath,
      outputPath,
    ];

    if (size !== 'original') {
      args.push(`--max_dimension`, `${size}`);
    }

    const process = spawn(pythonPath, args);

    let stderr = "";

    process.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    process.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        console.error(`[ImageCache] Python script failed: ${stderr}`);
        reject(new Error(`Image conversion failed: ${stderr}`));
      }
    });

    process.on("error", (err) => {
      console.error(`[ImageCache] Failed to start python process: ${err.message}`);
      reject(err);
    });
  });

/** Converts an image to the specified size and caches the result. Returning the cached file path. */
export const convertImage = async (
  filePath: string,
  size: ImageSize,
): Promise<string> => {
  const hash = getHash(filePath);
  const cachedPath = getCachedFilePath(hash, size);

  if (existsSync(cachedPath)) {
    return cachedPath;
  }

  console.log(`[ImageCache] Generating ${size} for ${filePath}`);
  await generateImage(filePath, cachedPath, size);
  return cachedPath;
};
