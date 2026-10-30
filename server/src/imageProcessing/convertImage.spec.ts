import { afterAll, describe, expect, it } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

// A fresh cache, so the conversion really runs instead of returning an earlier result.
const cacheDir = mkdtempSync(path.join(os.tmpdir(), "photrix-convert-spec-"));
process.env.CACHE_DIR = cacheDir;
const { convertImage } = await import("./convertImage.ts");

/** Stored 1400x933 (landscape) with EXIF Orientation 8: it displays as a 933x1400 portrait. */
const rotatedJpeg = fileURLToPath(
  new URL("../../exampleFolder/subFolder/grandchildFolder/1V7A4755.JPG", import.meta.url),
);

describe("convertImage", () => {
  afterAll(() => rmSync(cacheDir, { recursive: true, force: true }));

  it("writes a WebP of the requested height, upright per the EXIF orientation", async () => {
    const outputPath = await convertImage(rotatedJpeg, 320);
    const { format, width, height } = await sharp(outputPath).metadata();

    expect(format).toBe("webp");
    expect(height).toBe(320);
    expect(width).toBe(Math.round((320 * 933) / 1400));
  }, 30_000);
});
