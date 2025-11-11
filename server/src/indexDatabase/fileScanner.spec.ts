import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { FileScanner } from "./fileScanner.ts";
import { IndexDatabase } from "./indexDatabase.ts";

const waitFor = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("FileWatcher", () => {
  let tempDir: string;
  let db: IndexDatabase;
  let watcher: FileScanner;

  beforeEach(async () => {
    // Create a temporary directory for testing
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "photrix-watcher-"));
    db = new IndexDatabase(tempDir);
  });

  afterEach(async () => {
    // Clean up
    if (watcher) {
      await watcher.stopWatching();
    }
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

  it("adds files to job queue when they are detected", async () => {
    watcher = new FileScanner(tempDir, db);
    await waitFor(500);

    // Create a new file after watcher is running
    await fs.writeFile(path.join(tempDir, "new-file.jpg"), "new content");

    // Wait for watcher to detect the file
    await waitFor(500);

    // Check that the file was added to the job queue
    const hasFileInQueue =
      watcher.jobQueue.info.files.includes("new-file.jpg") ||
      watcher.jobQueue.exifMetadata.files.includes("new-file.jpg");

    expect(hasFileInQueue).toBe(true);
  });

  it("detects file changes and adds to job queue", async () => {
    // Create initial file
    const testFile = path.join(tempDir, "change-test.jpg");
    await fs.writeFile(testFile, "initial content");

    watcher = new FileScanner(tempDir, db);
    await waitFor(500);

    // Clear the job queue
    watcher.jobQueue.info.files = [];
    watcher.jobQueue.exifMetadata.files = [];

    // Modify the file
    await fs.writeFile(testFile, "modified content");

    // Wait for change detection
    await waitFor(500);

    // Check that the file was added to job queue
    const hasFileInQueue =
      watcher.jobQueue.info.files.includes("change-test.jpg") ||
      watcher.jobQueue.exifMetadata.files.includes("change-test.jpg");

    expect(hasFileInQueue).toBe(true);
  });

  it("removes files from database when deleted", async () => {
    // Create initial file
    const testFile = path.join(tempDir, "delete-test.jpg");
    await fs.writeFile(testFile, "content to delete");

    watcher = new FileScanner(tempDir, db);
    await waitFor(500);

    // Verify file is in database
    let record = await db.getFileRecord("delete-test.jpg");
    expect(record).toBeDefined();

    // Delete the file
    await fs.unlink(testFile);

    // Wait for unlink detection and move window timeout (500ms + buffer)
    await waitFor(700);

    // Verify file is removed from database
    record = await db.getFileRecord("delete-test.jpg");
    expect(record).toBeUndefined();
  });

  it("detects file moves within watched directory", async () => {
    // Create initial file with specific content
    const originalPath = path.join(tempDir, "original.jpg");
    const content = Buffer.from("test content for move detection");
    await fs.writeFile(originalPath, content);

    watcher = new FileScanner(tempDir, db);
    await waitFor(500);

    // Verify original file is tracked
    let originalRecord = await db.getFileRecord("original.jpg");
    expect(originalRecord).toBeDefined();

    // Move the file (rename within same directory)
    const movedPath = path.join(tempDir, "moved.jpg");
    await fs.rename(originalPath, movedPath);

    // Wait for move detection (unlink + add within 500ms window + processing)
    await waitFor(800);

    // Verify the file was moved (not deleted/added)
    originalRecord = await db.getFileRecord("original.jpg");
    const movedRecord = await db.getFileRecord("moved.jpg");

    expect(originalRecord).toBeUndefined();
    expect(movedRecord).toBeDefined();
    expect(movedRecord?.relativePath).toBe("moved.jpg");
  });

  it("can stop watching", async () => {
    watcher = new FileScanner(tempDir, db);
    await waitFor(300);

    await watcher.stopWatching();

    // Create a file after stopping - it should not be detected
    await fs.writeFile(path.join(tempDir, "after-stop.jpg"), "content");
    await waitFor(500);

    const record = await db.getFileRecord("after-stop.jpg");
    expect(record).toBeUndefined();
  });
});