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
    await this.runAllThumbnailMaintenance();
    this.startupComplete = true;
    console.log(`[fileWatcher] Startup complete`);
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
          const results = await Promise.all(batch.map(async (record) => {
            const mimeType = record.mimeType ?? mimeTypeForFilename(record.relativePath);
            if (!mimeType?.startsWith("image/") && !mimeType?.startsWith("video/")) return null;

            const fullPath = path.join(this.rootPath, record.relativePath);
            // Compute hash if not in database
            const hash = record.fileHash ?? await getHash({ filePath: fullPath });

            const needsProcessing = await this.needsThumbnailGeneration(mimeType, hash, desiredHeights);
            if (!needsProcessing) {
              return { relativePath: record.relativePath, hash, thumbnailsReady: true, error: null };
            }

            try {
              if (mimeType.startsWith("image/")) {
                await convertImageToMultipleSizes(fullPath, desiredHeights);
              } else {
                await generateVideoThumbnail(fullPath, 320);
              }
              return { relativePath: record.relativePath, hash, thumbnailsReady: true, error: null };
            } catch (error) {
              console.error(`[FileScanner] Error generating thumbnail for ${record.relativePath}:`, error);
              return { relativePath: record.relativePath, hash, thumbnailsReady: false, error: error as Error };
            }
          }));
          
          // Serialize database writes to avoid "busy" errors
          for (const result of results) {
            if (!result) continue;
            
            // Retry logic for database writes
            let attempts = 0;
            const maxAttempts = 5;
            while (attempts < maxAttempts) {
              try {
                const updateData: any = { 
                  thumbnailsProcessedAt: new Date().toISOString(),
                  fileHash: result.hash
                };
                if (result.thumbnailsReady) {
                  updateData.thumbnailsReady = true;
                  this.lastThumbnailResult = { relativePath: result.relativePath, completedAt: new Date().toISOString() };
                }
                await this.fileIndexDatabase.addOrUpdateFileData(result.relativePath, updateData);
                break; // Success, exit retry loop
              } catch (error) {
                attempts++;
                const message = error instanceof Error ? error.message : String(error);
                if (message.includes("busy") && attempts < maxAttempts) {
                  // Wait with exponential backoff before retrying
                  await new Promise((resolve) => setTimeout(resolve, 50 * attempts));
                  continue;
                }
                // Non-busy error or max attempts reached
                console.error(`[FileScanner] Error updating database for ${result.relativePath} (attempt ${attempts}):`, error);
                break;
              }
            }
            
            // Small delay between writes to reduce contention
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          
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
