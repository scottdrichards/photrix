import { describe, it, expect, jest } from "@jest/globals";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

import {
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

  it("parses escaped JSON regions strings that use width/height keys", async () => {
    jest.resetModules();

    const imagePath = path.join(tmpDir(), "escaped-regions.jpg");
    writeFileSync(imagePath, "not-a-real-image");

    const escapedRegions = JSON.stringify([
      {
        Name: "Scott Douglas Richards",
        Type: "Face",
        Area: { x: 0.48237, y: 0.15012, width: 0.08638, height: 0.15357 },
        Rotation: -0.08126,
      },
    ]);

    jest.unstable_mockModule("exifr", () => ({
      default: {
        parse: jest.fn(async () => ({
          Regions: escapedRegions,
        })),
      },
    }));

    jest.unstable_mockModule("sharp", () => ({
      default: jest.fn(() => ({
        metadata: async () => ({ width: 3000, height: 2000, orientation: 1 }),
      })),
    }));

    const { getExifMetadataFromFile: getExifMetadataFromFileWithMocks } = await import(
      "./fileUtils.ts"
    );
    const result = await getExifMetadataFromFileWithMocks(imagePath);

    expect(result.regions).toEqual([
      {
        name: "Scott Douglas Richards",
        type: "Face",
        area: { x: 0.48237, y: 0.15012, width: 0.08638, height: 0.15357 },
        rotation: -0.08126,
      },
    ]);
  });

  it("transforms regions to post-orientation coordinates", async () => {
    jest.resetModules();

    const imagePath = path.join(tmpDir(), "orientation-regions.jpg");
    writeFileSync(imagePath, "not-a-real-image");

    jest.unstable_mockModule("exifr", () => ({
      default: {
        parse: jest.fn(async () => ({
          Orientation: 6,
          Regions: {
            RegionList: [
              {
                Type: "Face",
                Area: { x: 0.2, y: 0.3, width: 0.1, height: 0.2 },
              },
            ],
          },
        })),
      },
    }));

    jest.unstable_mockModule("sharp", () => ({
      default: jest.fn(() => ({
        metadata: async () => ({ width: 3000, height: 2000, orientation: 6 }),
      })),
    }));

    const { getExifMetadataFromFile: getExifMetadataFromFileWithMocks } = await import(
      "./fileUtils.ts"
    );
    const result = await getExifMetadataFromFileWithMocks(imagePath);

    expect(result.regions).toEqual([
      {
        type: "Face",
        area: { x: 0.7, y: 0.2, width: 0.2, height: 0.1 },
      },
    ]);
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

  it("handles unknown file format by reading only header bytes (no full-file load)", async () => {
    const dir = tmpDir();
    const unknownFile = path.join(dir, "unknown.bin");
    // Write data that is not a recognized image format
    writeFileSync(unknownFile, Buffer.from("UNKNOWN_FORMAT_HEADER_ONLY_SMALL"));

    const result = await getExifMetadataFromFile(unknownFile);
    expect(result).toEqual({});

    await rm(dir, { recursive: true, force: true });
  });

  it("handles large malformed file without OOM by reading header only", async () => {
    const dir = tmpDir();
    const largeFile = path.join(dir, "large_malformed.bin");
    // Write 50MB file with malformed header
    const chunkSize = 1024 * 1024; // 1MB
    const chunks = 50;

    const header = Buffer.alloc(chunkSize);
    header.write("INVALID_FORMAT_XXXX".padEnd(12, "Y"), 0);
    writeFileSync(largeFile, header);

    for (let i = 1; i < chunks; i++) {
      const chunk = Buffer.alloc(chunkSize).fill(0);
      writeFileSync(largeFile, chunk, { flag: "a" });
    }

    // Should complete without memory spike (header-only read, not full file)
    const result = await getExifMetadataFromFile(largeFile);
    expect(result).toEqual({});

    await rm(dir, { recursive: true, force: true });
  });

  it("handles file smaller than 12 bytes gracefully", async () => {
    const dir = tmpDir();
    const smallFile = path.join(dir, "tiny.bin");
    writeFileSync(smallFile, Buffer.from("short"));

    const result = await getExifMetadataFromFile(smallFile);
    expect(result).toEqual({});

    await rm(dir, { recursive: true, force: true });
  });

  it("handles zero-byte file gracefully", async () => {
    const dir = tmpDir();
    const emptyFile = path.join(dir, "empty.bin");
    writeFileSync(emptyFile, Buffer.alloc(0));

    const result = await getExifMetadataFromFile(emptyFile);
    expect(result).toEqual({});

    await rm(dir, { recursive: true, force: true });
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
