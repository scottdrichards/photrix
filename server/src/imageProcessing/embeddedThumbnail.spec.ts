import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

const EXAMPLE_DIR = path.join(process.cwd(), "exampleFolder");
// Canon DSLR JPEG: carries a 160x120 embedded EXIF thumbnail, EXIF orientation 8
// (sensor is landscape 6960x4640, so the upright display is portrait).
const JPEG_WITH_THUMB = path.join(EXAMPLE_DIR, "subFolder/grandchildFolder/1V7A4755.JPG");
// 2012 phone JPEG: no embedded EXIF thumbnail.
const JPEG_WITHOUT_THUMB = path.join(EXAMPLE_DIR, "subFolder/20120803_160939.jpg");
const HEIC_FILE = path.join(EXAMPLE_DIR, "sewing-threads.heic");

let tempCacheDir: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let convertEmbeddedThumbnail: (
  filePath: string,
  maxHeight?: number,
) => Promise<string | null>;

beforeAll(async () => {
  tempCacheDir = mkdtempSync(path.join(os.tmpdir(), "photrix-micro-test-"));
  // cacheUtils reads CACHE_DIR at import time, so set it before importing.
  process.env.CACHE_DIR = tempCacheDir;
  ({ convertEmbeddedThumbnail } = await import("./embeddedThumbnail.ts"));
});

afterAll(() => {
  rmSync(tempCacheDir, { recursive: true, force: true });
});

describe("convertEmbeddedThumbnail", () => {
  it("extracts a JPEG's embedded thumbnail into a small oriented WebP", async () => {
    const out = await convertEmbeddedThumbnail(JPEG_WITH_THUMB, 160);
    expect(out).not.toBeNull();

    const meta = await sharp(out as string).metadata();
    expect(meta.format).toBe("webp");
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(160);
    // Orientation applied: the upright display of this file is portrait.
    expect(meta.height ?? 0).toBeGreaterThan(meta.width ?? 0);
    // Aspect-ratio crop applied: the embedded thumbnail is 4:3 (160×120) but the
    // sensor is 3:2 (6960×4640), so the output must be cropped to match 4640:6960
    // ≈ 0.667 (within 4% tolerance).
    const outputAspect = (meta.width ?? 0) / (meta.height ?? 0);
    const sourceAspect = 4640 / 6960;
    expect(Math.abs(outputAspect - sourceAspect)).toBeLessThan(0.04);
  });

  it("is idempotent and serves the cached file on repeat calls", async () => {
    const first = await convertEmbeddedThumbnail(JPEG_WITH_THUMB, 160);
    const second = await convertEmbeddedThumbnail(JPEG_WITH_THUMB, 160);
    expect(second).toBe(first);
  });

  it("returns null for a JPEG without an embedded thumbnail", async () => {
    expect(await convertEmbeddedThumbnail(JPEG_WITHOUT_THUMB, 160)).toBeNull();
  });

  it("returns null for HEIC (no EXIF thumbnail to extract)", async () => {
    expect(await convertEmbeddedThumbnail(HEIC_FILE, 160)).toBeNull();
  });
});
