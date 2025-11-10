import chokidar, { FSWatcher } from "chokidar";
import { stat } from "node:fs/promises";
import { MetadataGroups } from "./fileRecord.type.ts";
import { toRelative, walkFiles } from "./fileUtils.ts";
import { IndexDatabase } from "./indexDatabase.ts";
import { mimeTypeForFilename } from "./mimeTypes.ts";

/**
 * How long we wait after a potential unlink before deciding it really was a deletion.
 * Any add that happens while this timer is running can be considered the target of a move.
 */
const MOVE_DETECTION_WINDOW_MS = 500;

/**
 * Filesystem timestamps can jitter slightly between unlink/add events during a move.
 * We allow a small tolerance when comparing modified times so that legitimate moves still match.
 */
const MOVE_TIMESTAMP_TOLERANCE_MS = 20;

type Queue = {
  files: string[];
  active: boolean;
  /** For progress calculations (i.e., total means total for a batch, not remaining) */
  total: number;
};

type PendingMove = {
  timer: NodeJS.Timeout;
  sizeInBytes?: number;
  modifiedTimeMs?: number;
};
export class FileWatcher {
  private readonly watchedPath: string;
  private readonly fileIndexDatabase: IndexDatabase;
  private watcher: FSWatcher | null = null;

  private readonly pendingMoves = new Map<string, PendingMove>();

  public jobQueue: Record<keyof MetadataGroups, Queue> = {
    info: { files: [], active: false, total: 0 },
    exifMetadata: { files: [], active: false, total: 0 },
    aiMetadata: { files: [], active: false, total: 0 },
    faceMetadata: { files: [], active: false, total: 0 },
  };

  public scannedFilesCount = 0;

  constructor(watchedPath: string, fileIndexDatabase: IndexDatabase) {
    this.watchedPath = watchedPath;
    this.fileIndexDatabase = fileIndexDatabase;
    this.scanExistingFiles().then(() => this.startWatching());
  }

  async startWatching(): Promise<void> {
    if (this.watcher) {
      throw new Error("FileWatcher is already started");
    }

    const watcher = chokidar.watch(this.watchedPath, {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 100,
      },
    });

    watcher.on("add", (absolutePath) => {
      void this.handleAddEvent(absolutePath);
    });
    watcher.on("change", (absolutePath) => {
      const relativePath = toRelative(this.watchedPath, absolutePath);
      this.addFileToJobQueue(relativePath);
    });
    watcher.on("unlink", (absolutePath) => {
      void this.handleUnlinkEvent(absolutePath);
    });
    watcher.on("error", (error) => {
      console.error(`[fileWatcher] Watcher error for ${this.watchedPath}:`, error);
    });

    this.watcher = watcher;
  }

  private async scanExistingFiles(): Promise<void> {
    console.log(`[fileWatcher] Scanning existing files in ${this.watchedPath}`);
    this.scannedFilesCount = 0;

    for await (const absolutePath of walkFiles(this.watchedPath)) {
      const relativePath = toRelative(this.watchedPath, absolutePath);
      await this.fileIndexDatabase.addFile({
        relativePath,
        mimeType: mimeTypeForFilename(relativePath),
      });

      this.addFileToJobQueue(relativePath);

      this.scannedFilesCount++;

      if (this.scannedFilesCount % 100 === 0) {
        console.log(`[fileWatcher] Scanned ${this.scannedFilesCount} files...`);
      }
    }

    console.log(`[fileWatcher] Completed scanning ${this.scannedFilesCount} files`);
  }

  async stopWatching(): Promise<void> {
    await this.watcher?.close();
    this.watcher = null;

    this.pendingMoves.forEach((pending) => {
      clearTimeout(pending.timer);
    });
    this.pendingMoves.clear();
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
      if (!queue.files.includes(relativePath)) {
        queue.files.push(relativePath);
        queue.total += 1;
      }
    }
  }

  private async handleAddEvent(absolutePath: string): Promise<void> {
    const relativePath = toRelative(this.watchedPath, absolutePath);

    if (await this.determineIfMoveAndCompleteMove(relativePath, absolutePath)) {
      return;
    }

    this.addFileToJobQueue(relativePath);
  }

  private async handleUnlinkEvent(absolutePath: string): Promise<void> {
    const relativePath = toRelative(this.watchedPath, absolutePath);

    const existing = this.pendingMoves.get(relativePath);
    if (existing) {
      clearTimeout(existing.timer);
    }

    const timer = setTimeout(() => {
      this.pendingMoves.delete(relativePath);
      void this.fileIndexDatabase.removeFile(relativePath).catch((error) => {
        console.error(`[fileWatcher] Failed to remove ${relativePath}:`, error);
      });
    }, MOVE_DETECTION_WINDOW_MS);

    this.pendingMoves.set(relativePath, { timer });

    const record = await this.fileIndexDatabase.getFileRecord(relativePath);
    const entry = this.pendingMoves.get(relativePath);
    if (!entry) {
      return;
    }
    entry.sizeInBytes = record?.sizeInBytes;
    entry.modifiedTimeMs = record?.modified ? record.modified.getTime() : undefined;
  }

  /**
   * Checks whether the given add event corresponds to a previously observed unlink.
   *
   * We treat the sequence unlink->add (within MOVE_DETECTION_WINDOW_MS) as a move if the
   * file size matches and, when available, the modified timestamp aligns within tolerance.
   */
  private async determineIfMoveAndCompleteMove(
    newRelativePath: string,
    absolutePath: string,
  ): Promise<boolean> {
    if (this.pendingMoves.size === 0) {
      return false;
    }

    let stats;
    try {
      stats = await stat(absolutePath);
    } catch {
      return false;
    }

    const candidate = Array.from(this.pendingMoves.entries()).find(([_, pending]) => {
      if (pending.sizeInBytes !== undefined && pending.sizeInBytes !== stats.size) {
        return false;
      }
      if (pending.modifiedTimeMs !== undefined) {
        const delta = Math.abs(pending.modifiedTimeMs - stats.mtimeMs);
        if (delta > MOVE_TIMESTAMP_TOLERANCE_MS) {
          return false;
        }
      }
      return true;
    });

    if (!candidate) {
      return false;
    }

    const [oldRelativePath, pending] = candidate;

    clearTimeout(pending.timer);
    this.pendingMoves.delete(oldRelativePath);

    await this.fileIndexDatabase.moveFile(oldRelativePath, newRelativePath);

    return true;
  }
}
