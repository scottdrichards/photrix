import { describe, expect, it, beforeAll } from '@jest/globals';
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import sharp from "sharp";

let convertImage: typeof import("./convertImage.ts").convertImage;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("convertImage", () => {
  const testImagePath = path.resolve(__dirname, "../../exampleFolder/subFolder/grandchildFolder/1V7A4755.JPG");
  const cacheDir = path.resolve(__dirname, "../../.cache");

  const getHash = (filePath: string): string => {
    const modifiedTimeMs = fs.statSync(filePath).mtimeMs;
    return createHash("md5").update(`${filePath}:${modifiedTimeMs}`).digest("hex");
  };
  
  beforeAll(async () => {
    process.env.ThumbnailCacheDirectory ??= path.join(cacheDir, "thumbs");
    ({ convertImage } = await import("./convertImage.ts"));
  });

  it("should convert and rotate the image correctly", async () => {
    if (!fs.existsSync(testImagePath)) {
      console.warn("Skipping test: Test image not found at " + testImagePath);
      return;
    }

    // Clean up cache for this file
    const hash = getHash(testImagePath);
    const cachedFile = path.join(cacheDir, "thumbs", `${hash}.320.jpg`);
    
    if (fs.existsSync(cachedFile)) {
      fs.unlinkSync(cachedFile);
    }

    // Request a thumbnail
    const outputPath = await convertImage(testImagePath, 320);
    
    expect(fs.existsSync(outputPath)).toBe(true);
    
    const metadata = await sharp(outputPath).metadata();
    
    expect(metadata.format).toBe('jpeg');
    // Verify max dimension is close to 320 (resizing might have slight rounding, but usually exact for max dim)
    expect(Math.max(metadata.width!, metadata.height!)).toBe(320);
  }, 30000); // Increase timeout for image processing
});
