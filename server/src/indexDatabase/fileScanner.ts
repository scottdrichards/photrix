import { toRelative, walkFiles } from "../fileHandling/fileUtils.ts";
import { mimeTypeForFilename } from "../fileHandling/mimeTypes.ts";
import { MetadataGroups } from "./fileRecord.type.ts";
import { IndexDatabase } from "./indexDatabase.ts";

type Queue = {
  files: string[];
  active: boolean;
  /** For progress calculations (i.e., total means total for a batch, not remaining) */
  total: number;
};
export class FileScanner {
  private readonly rootPath: string;
  private readonly fileIndexDatabase: IndexDatabase;

  public jobQueue: Record<keyof MetadataGroups, Queue> = {
    info: { files: [], active: false, total: 0 },
    exifMetadata: { files: [], active: false, total: 0 },
    aiMetadata: { files: [], active: false, total: 0 },
    faceMetadata: { files: [], active: false, total: 0 },
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
  }


  addFileToJobQueue(
    relativePath: string,
    metadataGroups: Array<keyof MetadataGroups> = Object.keys(this.jobQueue) as Array<
      keyof MetadataGroups
    >,
  ): void {
    for (const group of metadataGroups) {
      this.jobQueue[group] ??= { files: [], active: false, total: 0 };
      const queue = this.jobQueue[group];
        queue.files.push(relativePath);
        queue.total += 1;
    }
  }
}
