import { afterEach, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileScanner } from "./fileScanner.ts";
import { IndexDatabase } from "./indexDatabase.ts";

const waitFor = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("FileWatcher", () => {
  let tempDir: string;
  let db: IndexDatabase;
  let watcher: FileScanner;

  beforeAll(async () => {
    process.env.ThumbnailCacheDirectory ??= path.join(os.tmpdir(), "photrix-test-thumbs");
    process.env.INDEX_DB_PATH = path.join(os.tmpdir(), "photrix-test-index.db");
  });

  beforeEach(async () => {
    // Create a temporary directory for testing
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "photrix-watcher-"));
    process.env.INDEX_DB_PATH = path.join(tempDir, "index.db");
    db = new IndexDatabase(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("scans existing files on initialization", async () => {
    // Create some test files
    await fs.writeFile(path.join(tempDir, "test1.jpg"), "test content 1");
    await fs.writeFile(path.join(tempDir, "test2.png"), "test content 2");

    // Create FileWatcher - it will scan existing files
    watcher = new FileScanner(tempDir, db);

    // Wait for scanning to complete
    await waitFor(500);

    expect(watcher.scannedFilesCount).toBe(2);

    const file1 = await db.getFileRecord("test1.jpg");
    const file2 = await db.getFileRecord("test2.png");

    expect(file1).toBeDefined();
    expect(file1?.relativePath).toBe("test1.jpg");
    expect(file2).toBeDefined();
    expect(file2?.relativePath).toBe("test2.png");
  });
});
