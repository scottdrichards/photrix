import { spawn } from "child_process";
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { StandardHeight } from "../common/standardHeights.ts";
import {
  getCachedFilePath as getSharedCachedFilePath,
  getHash,
} from "../common/cacheUtils.ts";

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "process_image.py");
const pythonPath = "python";


const generateImage = async (
  inputPath: string,
  outputs: Array<{ path: string; height: StandardHeight }>,
): Promise<void> =>
  new Promise((resolve, reject) => {
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
  await generateImage(filePath, [{ path: cachedPath, height }]);
  return cachedPath;
};

export const convertImageToMultipleSizes = async (
  filePath: string,
  heights: StandardHeight[],
): Promise<void> => {
  const hash = getHash(filePath);
  
  const outputs = heights
    .map(height => ({
      height,
      path: getSharedCachedFilePath(hash, height, "jpg")
    }))
    .filter(o => !existsSync(o.path));

  if (outputs.length === 0) {
    return;
  }

  console.log(`[ImageCache] Generating sizes ${outputs.map(o => o.height).join(", ")} for ${filePath}`);
  await generateImage(filePath, outputs);
};
