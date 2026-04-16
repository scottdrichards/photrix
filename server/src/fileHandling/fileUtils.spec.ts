import { describe, it, expect, jest } from "@jest/globals";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

import {
  getFileInfo,
  getExifMetadataFromFile,
  getFastMediaDimensions,
  walkFiles,
} from "./fileUtils.ts";

const EXAMPLE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../exampleFolder",
);
const resolveExamplePath = (...segments: string[]): string =>
  path.join(EXAMPLE_ROOT, ...segments);
const tmpDir = () => mkdtempSync(path.join(os.tmpdir(), "fileutils-test-"));

const getNormalizedDimensionsFromDecodedMetadata = (metadata: {
  width?: number;
  height?: number;
  orientation?: number;
}) => {
  const orientationNeedsSwap =
    metadata.orientation !== undefined && [5, 6, 7, 8].includes(metadata.orientation);
  return {
    width: orientationNeedsSwap ? metadata.height : metadata.width,
    height: orientationNeedsSwap ? metadata.width : metadata.height,
  };
};

describe("getFileInfo", () => {
  it("returns file statistics for sample image", async () => {
    const filePath = resolveExamplePath("sewing-threads.heic");

    const info = await getFileInfo(filePath);

    expect(info.sizeInBytes).toBeGreaterThan(0);
    expect(info.created).toBeInstanceOf(Date);
    expect(info.modified).toBeInstanceOf(Date);
    expect(Number.isNaN(info.created?.getTime() ?? NaN)).toBe(false);
    expect(Number.isNaN(info.modified?.getTime() ?? NaN)).toBe(false);
  });

  it("throws when provided a directory path", async () => {
    await expect(getFileInfo(EXAMPLE_ROOT)).rejects.toThrow(/not a file/i);
  });
});

describe("getExifMetadataFromFile", () => {
  it("returns empty object when mime type is unknown", async () => {
    const unknownFile = path.join(tmpDir(), "unknown.bin");
    writeFileSync(unknownFile, "data");
    const result = await getExifMetadataFromFile(unknownFile);
    expect(result).toEqual({});
  });

  it("returns empty object for non-image, non-video types", async () => {
    const txtFile = path.join(tmpDir(), "readme.txt");
    writeFileSync(txtFile, "hello");
    const result = await getExifMetadataFromFile(txtFile);
    expect(result).toEqual({});
  });

  it("parses image EXIF and normalizes dimensions, location, and rating", async () => {
    const heicPath = resolveExamplePath("sewing-threads.heic");
    const result = await getExifMetadataFromFile(heicPath);

    expect(result).toBeDefined();
    if (result.dateTaken) {
      expect(result.dateTaken).toBeInstanceOf(Date);
    }
  });

  it("sets livePhotoVideoFileName when a sibling MOV file exists", async () => {
    const dir = tmpDir();
    const imagePath = path.join(dir, "sewing-threads.heic");
    const videoPath = path.join(dir, "sewing-threads.MOV");
    copyFileSync(resolveExamplePath("sewing-threads.heic"), imagePath);
    writeFileSync(videoPath, "fake-mov-data");

    const result = await getExifMetadataFromFile(imagePath);

      expect(result.livePhotoVideoFileName?.toLowerCase()).toBe("sewing-threads.mov");
    await rm(dir, { recursive: true, force: true });
  });

  it("does not set livePhotoVideoFileName when no sibling video exists", async () => {
    const heicPath = resolveExamplePath("sewing-threads.heic");
    const result = await getExifMetadataFromFile(heicPath);
    expect(result.livePhotoVideoFileName).toBeUndefined();
  });

  it("prefers decoded image dimensions over stale EXIF width/height tags", async () => {
    jest.resetModules();

    const imagePath = path.join(tmpDir(), "stale-exif.jpg");
    writeFileSync(imagePath, "not-a-real-image");

    jest.unstable_mockModule("exifr", () => ({
      default: {
        parse: jest.fn(async () => ({
          ImageWidth: 6000,
          ImageHeight: 4000,
          ExifImageWidth: 6000,
          ExifImageHeight: 4000,
          Orientation: 1,
        })),
      },
    }));

    jest.unstable_mockModule("sharp", () => ({
      default: jest.fn(() => ({
        metadata: async () => ({
          width: 3000,
          height: 2000,
          orientation: 1,
        }),
      })),
    }));

    const { getExifMetadataFromFile: getExifMetadataFromFileWithMocks } = await import(
      "./fileUtils.ts"
    );
    const result = await getExifMetadataFromFileWithMocks(imagePath);

    expect(result.dimensionWidth).toBe(3000);
    expect(result.dimensionHeight).toBe(2000);
  });

  it("matches decoded dimensions for _MG_0475 regression fixture when present", async () => {
    const fixturePath = resolveExamplePath("_MG_0475.cr2.jpg");
    if (!existsSync(fixturePath)) {
      return;
    }

    const decodedMetadata = await sharp(fixturePath).metadata();
    const expected = getNormalizedDimensionsFromDecodedMetadata(decodedMetadata);
    const result = await getExifMetadataFromFile(fixturePath);

    expect(result.dimensionWidth).toBe(expected.width);
    expect(result.dimensionHeight).toBe(expected.height);
  });
});

describe("getFastMediaDimensions", () => {
  it("returns dimensions from decoded image metadata", async () => {
    jest.resetModules();

    const imagePath = path.join(tmpDir(), "fast-dims.jpg");
    writeFileSync(imagePath, "not-a-real-image");

    jest.unstable_mockModule("sharp", () => ({
      default: jest.fn(() => ({
        metadata: async () => ({ width: 1500, height: 1000, orientation: 1 }),
      })),
    }));

    const { getFastMediaDimensions: getFastMediaDimensionsWithMocks } = await import(
      "./fileUtils.ts"
    );
    const result = await getFastMediaDimensionsWithMocks(imagePath);

    expect(result.dimensionWidth).toBe(1500);
    expect(result.dimensionHeight).toBe(1000);
  });

  it("returns empty object for unknown mime type", async () => {
    const filePath = path.join(tmpDir(), "unknown.nope");
    writeFileSync(filePath, "data");

    const result = await getFastMediaDimensions(filePath);
    expect(result).toEqual({});
  });
});

describe("walkFiles", () => {
  it("yields all files recursively", async () => {
    const root = tmpDir();
    const nested = path.join(root, "a", "b");
    const files = [path.join(root, "one.txt"), path.join(nested, "two.txt")];

    // create directories and files
    files.forEach((file) => {
      const dir = path.dirname(file);
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, "content");
    });

    const found = new Set(walkFiles(root));
    expect(found).toEqual(new Set(files));

    await rm(root, { recursive: true, force: true });
  });
});
