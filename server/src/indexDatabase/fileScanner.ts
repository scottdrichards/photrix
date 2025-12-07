import { access, constants } from "node:fs/promises";
import path from "node:path";
import { getCachedFilePath, getHash } from "../common/cacheUtils.ts";
import { toRelative, walkFiles } from "../fileHandling/fileUtils.ts";
import { mimeTypeForFilename } from "../fileHandling/mimeTypes.ts";
import { convertImageToMultipleSizes } from "../imageProcessing/convertImage.ts";
import { generateVideoThumbnail } from "../videoProcessing/videoUtils.ts";
import { standardHeights } from "../common/standardHeights.ts";
import { IndexDatabase } from "./indexDatabase.ts";

type MaintenanceResult = {
  relativePath: string;
  completedAt: string;
};

export class FileScanner {
  private readonly rootPath: string;
  private readonly fileIndexDatabase: IndexDatabase;
  private initialScanComplete = false;
  private startupComplete = false;
  private thumbnailMaintenanceActive = false;
  private exifMaintenanceActive = false;
  private readonly maintenanceTimers: NodeJS.Timer[] = [];
  private lastThumbnailResult: MaintenanceResult | null = null;
  private lastExifResult: MaintenanceResult | null = null;

  public scannedFilesCount = 0;

  constructor(rootPath: string, fileIndexDatabase: IndexDatabase) {
    this.rootPath = rootPath;
    this.fileIndexDatabase = fileIndexDatabase;
    void this.scanExistingFiles();

    // Periodic maintenance - EXIF first, then thumbnails
    const maintenanceTimer = setInterval(() => {
      void (async () => {
        if (!this.startupComplete) return;
        await this.runAllExifMaintenance();
        await this.runAllThumbnailMaintenance();
      })();
    }, 60_000);
    maintenanceTimer.unref();
    this.maintenanceTimers.push(maintenanceTimer);
  }

  get latestThumbnail(): MaintenanceResult | null {
    return this.lastThumbnailResult;
  }

  get latestExif(): MaintenanceResult | null {
    return this.lastExifResult;
  }

  private async scanExistingFiles(): Promise<void> {
    console.log(`[fileWatcher] Discovering existing files in ${this.rootPath}`);
    this.scannedFilesCount = 0;

    const batchSize = 500;
    let batch: string[] = [];

    for (const absolutePath of walkFiles(this.rootPath)) {
      const relativePath = toRelative(this.rootPath, absolutePath);
      batch.push(relativePath);
      if (batch.length >= batchSize) {
        this.fileIndexDatabase.insertMissingPaths(batch);
        batch = [];
      }

      this.scannedFilesCount++;

      if (this.scannedFilesCount % 10000 === 0) {
        console.log(`[fileWatcher] Discovered ${this.scannedFilesCount} files...`);
      }
    }

    if (batch.length) {
      this.fileIndexDatabase.insertMissingPaths(batch);
    }

    console.log(`[fileWatcher] Completed discovering ${this.scannedFilesCount} files`);
    this.initialScanComplete = true;
    await this.runAllExifMaintenance();
    await this.reconcileExistingThumbnails();
    await this.runAllThumbnailMaintenance();
    this.startupComplete = true;
    console.log(`[fileWatcher] Startup complete`);
  }

  private async reconcileExistingThumbnails(): Promise<void> {
    const desiredHeights = standardHeights.filter((h) => h !== "original");
    // Materialize to avoid writing while iterating an open statement
    const records = Array.from(this.fileIndexDatabase.files());
    console.log(`[fileWatcher] Reconciling thumbnails for ${records.length} media entries...`);
    
    const readyPaths: string[] = [];
    let processed = 0;

    // Check filesystem in batches
    const BATCH_SIZE = 100;
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batch = records.slice(i, i + BATCH_SIZE);
      
      await Promise.all(batch.map(async (record) => {
        const mimeType = record.mimeType ?? mimeTypeForFilename(record.relativePath);
        if (!mimeType?.startsWith("image/") && !mimeType?.startsWith("video/")) return;

        const fullPath = path.join(this.rootPath, record.relativePath);
        const hash = record.fileHash ?? await getHash({ filePath: fullPath });
        const missing = await this.needsThumbnailGeneration(mimeType, hash, desiredHeights);
        if (!missing) {
          readyPaths.push(record.relativePath);
        }
      }));

      processed += batch.length;
      if (processed % 1000 === 0) {
        console.log(`[fileWatcher] Reconcile progress: ${processed}/${records.length} (${readyPaths.length} found ready)`);
      }
    }

    // Batch update DB
    console.log(`[fileWatcher] Updating ${readyPaths.length} records in database...`);
    for (const relativePath of readyPaths) {
      await this.fileIndexDatabase.addOrUpdateFileData(relativePath, { thumbnailsReady: true, thumbnailsProcessedAt: new Date().toISOString() });
      if (readyPaths.indexOf(relativePath) % 100 === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    console.log(`[fileWatcher] Reconcile complete: ${records.length} checked, ${readyPaths.length} marked ready`);
  }

  private async runAllThumbnailMaintenance(): Promise<void> {
    if (this.thumbnailMaintenanceActive) return;
    this.thumbnailMaintenanceActive = true;
    const desiredHeights = standardHeights.filter((h) => h !== "original");
    const BATCH_SIZE = 50;
    const CONCURRENCY = 4;
    let totalProcessed = 0;

    try {
      console.log(`[FileScanner] Starting thumbnail maintenance...`);
      let lastYield = Date.now();

      while (true) {
        const candidates = this.fileIndexDatabase.getRecordsNeedingThumbnails(BATCH_SIZE);
        if (!candidates.length) break;

        // Process in concurrent sub-batches
        while (candidates.length > 0) {
          const batch = candidates.splice(0, CONCURRENCY);
          await Promise.all(batch.map(async (record) => {
            const mimeType = record.mimeType ?? mimeTypeForFilename(record.relativePath);
            if (!mimeType?.startsWith("image/") && !mimeType?.startsWith("video/")) return;

            const fullPath = path.join(this.rootPath, record.relativePath);
            // Compute and store hash if not in database
            const hash = record.fileHash ?? await getHash({ filePath: fullPath });
            if (!record.fileHash) {
              await this.fileIndexDatabase.addOrUpdateFileData(record.relativePath, { fileHash: hash });
            }

            const needsProcessing = await this.needsThumbnailGeneration(mimeType, hash, desiredHeights);
            if (!needsProcessing) {
              await this.fileIndexDatabase.addOrUpdateFileData(record.relativePath, { thumbnailsReady: true, thumbnailsProcessedAt: new Date().toISOString() });
              this.lastThumbnailResult = { relativePath: record.relativePath, completedAt: new Date().toISOString() };
              return;
            }

            try {
              if (mimeType.startsWith("image/")) {
                await convertImageToMultipleSizes(fullPath, desiredHeights);
              } else {
                await generateVideoThumbnail(fullPath, 320);
              }
              await this.fileIndexDatabase.addOrUpdateFileData(record.relativePath, { thumbnailsReady: true, thumbnailsProcessedAt: new Date().toISOString() });
              this.lastThumbnailResult = { relativePath: record.relativePath, completedAt: new Date().toISOString() };
            } catch (error) {
              console.error(`[FileScanner] Error generating thumbnail for ${record.relativePath}:`, error);
              await this.fileIndexDatabase.addOrUpdateFileData(record.relativePath, { thumbnailsProcessedAt: new Date().toISOString() });
            }
          }));
          totalProcessed += batch.length;
        }

        // Yield every 100ms
        if (Date.now() - lastYield > 100) {
          console.log(`[FileScanner] Thumbnail progress: ${totalProcessed} processed`);
          await new Promise((resolve) => setImmediate(resolve));
          lastYield = Date.now();
        }
      }

      console.log(`[FileScanner] Thumbnail maintenance complete: ${totalProcessed} processed`);
    } finally {
      this.thumbnailMaintenanceActive = false;
    }
  }

  private async runAllExifMaintenance(): Promise<void> {
    if (this.exifMaintenanceActive) return;
    this.exifMaintenanceActive = true;
    const BATCH_SIZE = 50;
    const CONCURRENCY = 20;
    let totalProcessed = 0;

    try {
      console.log(`[FileScanner] Starting EXIF maintenance...`);
      let lastYield = Date.now();

      while (true) {
        const candidates = this.fileIndexDatabase.getRecordsMissingDateTaken(BATCH_SIZE);
        if (!candidates.length) break;

        // Process in concurrent sub-batches
        while (candidates.length > 0) {
          const batch = candidates.splice(0, CONCURRENCY);
          await Promise.all(batch.map(async (record) => {
            try {
              await this.fileIndexDatabase.getFileRecord(record.relativePath, ["dateTaken"]);
              this.lastExifResult = { relativePath: record.relativePath, completedAt: new Date().toISOString() };
            } catch (error) {
              console.error(`[FileScanner] Error processing EXIF for ${record.relativePath}:`, error);
            }
          }));
          totalProcessed += batch.length;
        }

        // Yield every 100ms
        if (Date.now() - lastYield > 100) {
          console.log(`[FileScanner] EXIF progress: ${totalProcessed} processed`);
          await new Promise((resolve) => setImmediate(resolve));
          lastYield = Date.now();
        }
      }

      console.log(`[FileScanner] EXIF maintenance complete: ${totalProcessed} processed`);
    } finally {
      this.exifMaintenanceActive = false;
    }
  }

  private async needsThumbnailGeneration(
    mimeType: string | null,
    hash: string,
    desiredHeights: Array<number | "original">,
  ): Promise<boolean> {
    if (mimeType?.startsWith("image/")) {
      for (const height of desiredHeights) {
        const cachedPath = getCachedFilePath(hash, height, "jpg");
        try {
          await access(cachedPath, constants.F_OK);
        } catch {
          return true;
        }
      }
      return false;
    }

    if (mimeType?.startsWith("video/")) {
      const cachedPath = getCachedFilePath(hash, 320, "jpg");
      try {
        await access(cachedPath, constants.F_OK);
        return false;
      } catch {
        return true;
      }
    }
    return false;
  }
}
