import { spawn } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdirSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

export const standardHeights = [
  160,
  320,
  640,
  1080,
  2160,
  'original',
 ] as const;

export type StandardHeights = typeof standardHeights[number];

const cacheDir = join(process.cwd(), ".cache");
const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "process_image.py");
const pythonPath = "python";

// Initialize cache directory
if (!existsSync(cacheDir)) {
  mkdirSync(cacheDir, { recursive: true });
}
console.log(`[ImageCache] Initialized at ${cacheDir}`);

const getHash = (filePath: string): string =>
  createHash("md5").update(filePath).digest("hex");

const getCachedFilePath = (hash: string, height: StandardHeights) =>
  join(cacheDir, `${hash}.${height}.jpeg`);

const generateImage = async (
  inputPath: string,
  outputPath: string,
  height: StandardHeights,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const args = [
      scriptPath,
      inputPath,
      outputPath,
    ];

    if (height !== 'original') {
      args.push(`--max_dimension`, `${height}`);
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

/** Converts an image to the specified height and caches the result. Returning the cached file path. */
export const convertImage = async (
  filePath: string,
  height: StandardHeights = 2160,
): Promise<string> => {
  const hash = getHash(filePath);
  const cachedPath = getCachedFilePath(hash, height);

  if (existsSync(cachedPath)) {
    return cachedPath;
  }

  console.log(`[ImageCache] Generating ${height} for ${filePath}`);
  await generateImage(filePath, cachedPath, height);
  return cachedPath;
};
