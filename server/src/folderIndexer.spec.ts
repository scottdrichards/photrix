import { Buffer } from "node:buffer";
import { cp, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createExampleWorkspace, waitForCondition } from "../tests/testUtils.js";
import { FolderIndexer } from "./folderIndexer.js";
import * as metadataModule from "./metadata.js";
import { isDiscoveredRecord, isFullFileRecord } from "./models.js";

describe("FolderIndexer", () => {
  it("indexes existing files on startup", async () => {
    const workspace = await createExampleWorkspace();
    const indexer = new FolderIndexer(workspace, { watch: false });
    try {
      await indexer.start();
      const records = indexer.listIndexedFiles();
      const fullRecords = records.filter(isFullFileRecord);
      const indexedPaths = fullRecords.map((r) => r.path).sort();
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
      if (!record || !isFullFileRecord(record)) {
        throw new Error("Expected full file record");
      }
      expect(record.metadata.dimensions).toEqual({ width: 4000, height: 3000 });
      // Check that dateTaken exists and is from December 2023 (timezone may vary)
      expect(record.metadata.dateTaken).toBeDefined();
      expect(record.metadata.dateTaken?.startsWith("2023-12-12")).toBe(true);
      expect(record.metadata.cameraMake?.toLowerCase()).toBe("samsung");
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
        (value) => value !== undefined && isFullFileRecord(value),
      );

      expect(record).toBeDefined();
      if (record && isFullFileRecord(record)) {
        expect(record.path).toBe("notes.txt");
        expect(Object.prototype.hasOwnProperty.call(record.metadata ?? {}, "name")).toBe(
          false,
        );
        expect(record.metadata.size).toBeGreaterThan(0);
      } else {
        throw new Error("Expected full file record");
      }
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

      const remaining = indexer
        .listIndexedFiles()
        .filter(isFullFileRecord)
        .map((r) => r.path);
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
        (value) => value !== undefined && isFullFileRecord(value),
      );

      // Append a byte to update the file size and mtime.
      const buffer = await readFile(target);
      const mutated = Buffer.concat([buffer, Buffer.from([0x00])]);
      await writeFile(target, mutated);

      const updated = await waitForCondition(
        () => indexer.getIndexedFile(targetRelative),
        (value) =>
          value !== undefined &&
          isFullFileRecord(value) &&
          value.lastIndexedAt !== original?.lastIndexedAt,
      );

      if (
        original &&
        isFullFileRecord(original) &&
        updated &&
        isFullFileRecord(updated)
      ) {
        expect(updated.metadata.size ?? 0).toBeGreaterThan(original.metadata.size ?? 0);
        expect(updated.dateModified).not.toBe(original.dateModified);
      } else {
        throw new Error("Expected full file records");
      }
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
        (value) => value !== undefined && isFullFileRecord(value),
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
        (value) => value !== undefined && isFullFileRecord(value),
      );

      if (record && isFullFileRecord(record)) {
        expect(record.name).toBe(newRel);
        expect(Object.prototype.hasOwnProperty.call(record.metadata ?? {}, "name")).toBe(
          false,
        );
      } else {
        throw new Error("Expected full file record");
      }
    } finally {
      await indexer.stop(true);
    }
  });

  it("handles files in discovery phase that are not yet fully indexed", async () => {
    const workspace = await createExampleWorkspace();

    // Mock buildIndexedRecord to hang indefinitely, simulating slow metadata extraction
    const buildIndexedRecordSpy = vi.spyOn(metadataModule, "buildIndexedRecord");

    // Create a promise that never resolves to simulate hanging metadata extraction
    buildIndexedRecordSpy.mockImplementation(async () => {
      return new Promise(() => {
        // Never resolve - simulates hanging on metadata extraction
      });
    });

    const indexer = new FolderIndexer(workspace, { watch: false });
    try {
      // Start the indexer in the background - discovery will complete, but metadata will hang
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      indexer.start();

      // Wait a bit to ensure discovery phase has completed but metadata phase is still processing
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Check that files are discovered but not fully indexed
      const records = indexer.listIndexedFiles();
      expect(records.length).toBeGreaterThan(0);

      // All records should be in discovered state (not fully indexed)
      const discoveredRecords = records.filter(isDiscoveredRecord);
      expect(discoveredRecords.length).toBe(2); // The two HEIC files in example folder

      // Verify that the records have relativePath but no full metadata
      discoveredRecords.forEach((record) => {
        expect(record.relativePath).toBeDefined();
        expect(record.lastIndexedAt).toBe(null);
      });

      // Try to get a specific file - should return the discovered record
      const specificRecord = indexer.getIndexedFile("sewing-threads.heic");
      expect(specificRecord).toBeDefined();
      expect(isDiscoveredRecord(specificRecord!)).toBe(true);
      expect(isFullFileRecord(specificRecord!)).toBe(false);

      // Don't await startPromise since it will hang
    } finally {
      // Restore the original implementation before stopping
      buildIndexedRecordSpy.mockRestore();
      await indexer.stop(true);
    }
  });
});
