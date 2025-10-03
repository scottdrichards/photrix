import { cp, writeFile, unlink, readFile } from "node:fs/promises";
import path from "node:path";
import { Buffer } from "node:buffer";
import { describe, it, expect } from "vitest";
import { FolderIndexer } from "./folderIndexer.js";
import { createExampleWorkspace, waitForCondition } from "../tests/testUtils.js";

describe("FolderIndexer", () => {
  it("indexes existing files on startup", async () => {
    const workspace = await createExampleWorkspace();
    const indexer = new FolderIndexer(workspace, { watch: false });
    try {
      await indexer.start();
      const records = indexer.listIndexedFiles();
      const indexedPaths = records.map((r) => r.path).sort();
      expect(indexedPaths).toEqual(["sewing-threads.heic", "subFolder/soundboard.heic"]);
    } finally {
      await indexer.stop(true);
    }
  });

  it("captures rich metadata for HEIC images", async () => {
    const workspace = await createExampleWorkspace();
    const indexer = new FolderIndexer(workspace, { watch: false });
    try {
      await indexer.start();
      const record = indexer.getIndexedFile("sewing-threads.heic");
      expect(record).toBeDefined();
      expect(record?.metadata.dimensions).toEqual({ width: 4000, height: 3000 });
      expect(record?.metadata.dateTaken).toBe("2023-12-12T23:39:16.000Z");
      expect(record?.metadata.cameraMake?.toLowerCase()).toBe("samsung");
    } finally {
      await indexer.stop(true);
    }
  });

  it("indexes newly added files", async () => {
    const workspace = await createExampleWorkspace();
    const indexer = new FolderIndexer(workspace);
    try {
      await indexer.start();
      const newFile = path.join(workspace, "notes.txt");
      await writeFile(newFile, "hello world", "utf8");

      const record = await waitForCondition(
        () => indexer.getIndexedFile("notes.txt"),
        (value) => value !== undefined,
      );

      expect(record?.path).toBe("notes.txt");
      expect(
        Object.prototype.hasOwnProperty.call(record?.metadata ?? {}, "name"),
      ).toBe(false);
      expect(record?.metadata.size).toBeGreaterThan(0);
    } finally {
      await indexer.stop(true);
    }
  });

  it("removes deleted files from the index", async () => {
    const workspace = await createExampleWorkspace();
    const indexer = new FolderIndexer(workspace);
    try {
      await indexer.start();
      const target = path.join(workspace, "sewing-threads.heic");
      await unlink(target);

      await waitForCondition(
        () => indexer.getIndexedFile("sewing-threads.heic"),
        (value) => value === undefined,
      );

      const remaining = indexer.listIndexedFiles().map((r) => r.path);
      expect(remaining).not.toContain("sewing-threads.heic");
    } finally {
      await indexer.stop(true);
    }
  });

  it("updates metadata when files change", async () => {
    const workspace = await createExampleWorkspace();
    const indexer = new FolderIndexer(workspace);
    try {
      await indexer.start();
      const targetRelative = "sewing-threads.heic";
      const target = path.join(workspace, targetRelative);

      const original = await waitForCondition(
        () => indexer.getIndexedFile(targetRelative),
        (value) => value !== undefined,
      );

      // Append a byte to update the file size and mtime.
      const buffer = await readFile(target);
      const mutated = Buffer.concat([buffer, Buffer.from([0x00])]);
      await writeFile(target, mutated);

      const updated = await waitForCondition(
        () => indexer.getIndexedFile(targetRelative),
        (value) => (value?.lastIndexedAt ?? "") !== (original?.lastIndexedAt ?? ""),
      );
      expect(updated?.metadata.size ?? 0).toBeGreaterThan(original?.metadata.size ?? 0);
      expect(updated?.dateModified).not.toBe(original?.dateModified);
    } finally {
      await indexer.stop(true);
    }
  });

  it("updates index when files are renamed", async () => {
    const workspace = await createExampleWorkspace();
    const indexer = new FolderIndexer(workspace);
    try {
      await indexer.start();
      const oldRel = "sewing-threads.heic";
      const newRel = "renamed-sewing.heic";
      const oldPath = path.join(workspace, oldRel);
      const newPath = path.join(workspace, newRel);

      await waitForCondition(
        () => indexer.getIndexedFile(oldRel),
        (value) => value !== undefined,
      );

      // Move the file (copy then remove to avoid cross-filesystem issues)
      await cp(oldPath, newPath);
      await unlink(oldPath);

      await waitForCondition(
        () => indexer.getIndexedFile(oldRel),
        (value) => value === undefined,
      );

      const record = await waitForCondition(
        () => indexer.getIndexedFile(newRel),
        (value) => value !== undefined,
      );

      expect(record?.name).toBe(newRel);
      expect(
        Object.prototype.hasOwnProperty.call(record?.metadata ?? {}, "name"),
      ).toBe(false);
    } finally {
      await indexer.stop(true);
    }
  });
});
