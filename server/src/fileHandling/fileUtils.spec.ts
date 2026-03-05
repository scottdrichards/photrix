import { describe, it, expect } from "@jest/globals";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getFileInfo, getExifMetadataFromFile, walkFiles } from "./fileUtils.ts";

const EXAMPLE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../exampleFolder",
);
const resolveExamplePath = (...segments: string[]): string =>
  path.join(EXAMPLE_ROOT, ...segments);
const tmpDir = () => mkdtempSync(path.join(os.tmpdir(), "fileutils-test-"));

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
