import { spawn } from "child_process";
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { StandardHeight } from "../common/standardHeights.ts";
import {
  ensureCacheDirExists,
  getCachedFilePath as getSharedCachedFilePath,
  getHash,
  CACHE_DIR,
} from "../common/cacheUtils.ts";

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "process_image.py");
const pythonPath = "python";

ensureCacheDirExists();
console.log(`[ImageCache] Initialized at ${CACHE_DIR}`);

const generateImage = async (
  inputPath: string,
  outputPath: string,
  height: StandardHeight,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const args = [
      scriptPath,
      inputPath,
      outputPath,
      ...(height !== 'original' ? ['--max_dimension', `${height}`] : [])
    ];

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

/**
 * Creates a converted image at the specified height, caching the result.
 * @returns Path of converted image
 */
export const convertImage = async (
  filePath: string,
  height: StandardHeight = 2160,
): Promise<string> => {
  const hash = getHash(filePath);
  const cachedPath = getSharedCachedFilePath(hash, height, "jpg");

  if (existsSync(cachedPath)) {
    return cachedPath;
  }

  console.log(`[ImageCache] Generating ${height} for ${filePath}`);
  await generateImage(filePath, cachedPath, height);
  return cachedPath;
};
