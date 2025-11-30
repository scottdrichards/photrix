import { toRelative, walkFiles } from "../fileHandling/fileUtils.ts";
import { mimeTypeForFilename } from "../fileHandling/mimeTypes.ts";
import { MetadataGroups } from "./fileRecord.type.ts";
import { IndexDatabase } from "./indexDatabase.ts";
import path from "node:path";
import { convertImage } from "../imageProcessing/convertImage.ts";
import { generateVideoThumbnail } from "../videoProcessing/videoUtils.ts";

type Queue = {
  files: string[];
  active: boolean;
  /** For progress calculations (i.e., total means total for a batch, not remaining) */
  total: number;
};
export class FileScanner {
  private readonly rootPath: string;
  private readonly fileIndexDatabase: IndexDatabase;
  private initialScanComplete = false;

  public jobQueues: Record<keyof MetadataGroups | "thumbnail", Queue> = {
    info: { files: [], active: false, total: 0 },
    exifMetadata: { files: [], active: false, total: 0 },
    aiMetadata: { files: [], active: false, total: 0 },
    faceMetadata: { files: [], active: false, total: 0 },
    thumbnail: { files: [], active: false, total: 0 },
  };

  public scannedFilesCount = 0;

  constructor(rootPath: string, fileIndexDatabase: IndexDatabase) {
    this.rootPath = rootPath;
    this.fileIndexDatabase = fileIndexDatabase;
    void this.scanExistingFiles();
  }

  private async scanExistingFiles(): Promise<void> {
    console.log(`[fileWatcher] Scanning existing files in ${this.rootPath}`);
    this.scannedFilesCount = 0;

    for (const absolutePath of walkFiles(this.rootPath)) {
      const relativePath = toRelative(this.rootPath, absolutePath);
      await this.fileIndexDatabase.addFile({
        relativePath,
        mimeType: mimeTypeForFilename(relativePath),
      });

      this.addFileToJobQueue(relativePath);

      this.scannedFilesCount++;

      if (this.scannedFilesCount % 10000 === 0) {
        console.log(`[fileWatcher] Scanned ${this.scannedFilesCount} files...`);
      }
    }

    console.log(`[fileWatcher] Completed scanning ${this.scannedFilesCount} files`);
    this.initialScanComplete = true;
    void this.processExifQueue();
    void this.processThumbnailQueue();
  }


  addFileToJobQueue(
    relativePath: string,
    metadataGroups: Array<keyof MetadataGroups | "thumbnail"> = Object.keys(this.jobQueues) as Array<
      keyof MetadataGroups | "thumbnail"
    >,
  ): void {
    for (const group of metadataGroups) {
      this.jobQueues[group] ??= { files: [], active: false, total: 0 };
      const queue = this.jobQueues[group];
      queue.files.push(relativePath);
      queue.total += 1;

      if (this.initialScanComplete && group === "exifMetadata" && !queue.active) {
        void this.processExifQueue();
      }
      if (this.initialScanComplete && group === "thumbnail" && !queue.active) {
        void this.processThumbnailQueue();
      }
    }
  }

  private async processThumbnailQueue(): Promise<void> {
    const queue = this.jobQueues.thumbnail;
    if (queue.active) return;
    queue.active = true;

    console.log("[FileScanner] Starting background thumbnail generation...");
    const CONCURRENCY_LIMIT = 4;

    while (queue.files.length > 0) {
      const batch: string[] = [];
      while (batch.length < CONCURRENCY_LIMIT && queue.files.length > 0) {
        const file = queue.files.shift();
        if (file) batch.push(file);
      }

      await Promise.all(batch.map(async (relativePath) => {
        const fullPath = path.join(this.rootPath, relativePath);
        const mimeType = mimeTypeForFilename(relativePath);

        try {
          if (mimeType?.startsWith("image/")) {
            await convertImage(fullPath, 320);
          } else if (mimeType?.startsWith("video/")) {
            await generateVideoThumbnail(fullPath, 320);
          }
        } catch (error) {
          console.error(
            `[FileScanner] Error generating thumbnail for ${relativePath}:`,
            error,
          );
        }
      }));

      // Yield to event loop and wait a bit to avoid preempting live requests
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    queue.total = 0;
    queue.active = false;
    console.log("[FileScanner] Background thumbnail generation complete.");
  }

  private async processExifQueue(): Promise<void> {
    const queue = this.jobQueues.exifMetadata;
    if (queue.active) return;
    queue.active = true;

    console.log("[FileScanner] Starting background EXIF processing...");

    while (queue.files.length > 0) {
      const relativePath = queue.files.shift();
      if (!relativePath) continue;

      try {
        // Requesting 'dateTaken' triggers EXIF hydration if missing
        await this.fileIndexDatabase.getFileRecord(relativePath, ["dateTaken"]);
      } catch (error) {
        console.error(
          `[FileScanner] Error processing EXIF for ${relativePath}:`,
          error,
        );
      }

      // Yield to event loop
      await new Promise((resolve) => setImmediate(resolve));
    }

    queue.total = 0;
    queue.active = false;
    console.log("[FileScanner] Background EXIF processing complete.");
  }
}
