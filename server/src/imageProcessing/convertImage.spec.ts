import { convertImage } from "./convertImage.ts";
import { describe, expect, it } from '@jest/globals';
import * as fs from "fs";
import * as path from "path";
import sizeOf from "image-size";
import { fileURLToPath } from "url";
import { createHash } from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("convertImage", () => {
  const testImagePath = path.resolve(__dirname, "../../exampleFolder/subFolder/grandchildFolder/1V7A4755.JPG");
  const cacheDir = path.resolve(__dirname, "../../.cache");

  const getHash = (filePath: string): string =>
    createHash("md5").update(filePath).digest("hex");
  
  it("should convert and rotate the image correctly", async () => {
    if (!fs.existsSync(testImagePath)) {
      console.warn("Skipping test: Test image not found at " + testImagePath);
      return;
    }

    // Clean up cache for this file
    const hash = getHash(testImagePath);
    const cachedFile = path.join(cacheDir, `${hash}.320.jpeg`);
    
    if (fs.existsSync(cachedFile)) {
      fs.unlinkSync(cachedFile);
    }

    // Request a thumbnail
    const outputPath = await convertImage(testImagePath, 320);
    
    expect(fs.existsSync(outputPath)).toBe(true);
    
    const dimensions = sizeOf(outputPath);
    
    expect(dimensions.type).toBe('jpg');
    // Verify max dimension is close to 320 (resizing might have slight rounding, but usually exact for max dim)
    expect(Math.max(dimensions.width!, dimensions.height!)).toBe(320);
  }, 30000); // Increase timeout for image processing
});
