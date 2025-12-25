import { toRelative, walkFiles } from "../fileHandling/fileUtils.ts";
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
  private exifMaintenanceActive = false;
  private readonly maintenanceTimers: NodeJS.Timer[] = [];
  private lastExifResult: MaintenanceResult | null = null;

  public scannedFilesCount = 0;

  constructor(rootPath: string, fileIndexDatabase: IndexDatabase) {
    this.rootPath = rootPath;
    this.fileIndexDatabase = fileIndexDatabase;
    void this.scanDirectory();

    // Periodic maintenance - EXIF only
    const maintenanceTimer = setInterval(() => {
      void (async () => {
        if (!this.startupComplete) return;
        await this.runAllExifMaintenance();
      })();
    }, 60_000);
    maintenanceTimer.unref();
    this.maintenanceTimers.push(maintenanceTimer);
  }

  get latestExif(): MaintenanceResult | null {
    return this.lastExifResult;
  }

  private async scanDirectory(directory:string = this.rootPath): Promise<void> {
    console.log(`[fileWatcher] Discovering existing files in ${this.rootPath}`);
    this.scannedFilesCount = 0;

    /** How many sqlite inserts to batch together. Doing them one at a time is way too slow */
    const batchSize = 500;
    let batch: string[] = [];

    for (const absolutePath of walkFiles(directory)) {
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
  }

}
