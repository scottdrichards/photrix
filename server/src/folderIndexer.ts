import chokidar, { FSWatcher } from "chokidar";
import { promises as fs } from "fs";
import path from "path";
import type { AllMetadata, Filter } from "../apiSpecification.js";
import type {
  DiscoveredFileRecord,
  IndexFileRecord,
  QueryOptions,
  QueryResult,
} from "./indexDatabase.js";
import { IndexDatabase, isDiscoveredRecord } from "./indexDatabase.js";
import { buildIndexedRecord } from "./metadata.js";
import { mimeTypeForFilename } from "./mimeTypes.js";

interface FolderIndexerOptions {
  dbFile?: string;
  watch?: boolean;
  awaitWriteFinish?: boolean;
}

const DEFAULT_OPTIONS: Required<
  Pick<FolderIndexerOptions, "watch" | "awaitWriteFinish">
> = {
  watch: true,
  awaitWriteFinish: true,
};

export class FolderIndexer {
  private watcher: FSWatcher | null = null;
  private readonly db: IndexDatabase;
  private readonly options: typeof DEFAULT_OPTIONS & FolderIndexerOptions;
  private readonly root: string;
  private isInitialIndexing = false;

  constructor(rootDir: string, options: FolderIndexerOptions = {}) {
    this.root = path.resolve(rootDir);
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.db = new IndexDatabase(options.dbFile);
  }

  async start(): Promise<void> {
    await this.discoverFiles();
    await this.processDiscoveredFiles();
    if (this.options.watch) {
      await this.startWatcher();
    }
  }

  async stop(closeDatabase = false): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    if (closeDatabase) {
      this.db.close();
    }
  }

  getDatabase(): IndexDatabase {
    return this.db;
  }

  getRootDirectory(): string {
    return this.root;
  }

  async indexFile(filePath: string, skipIfUnchanged = false): Promise<boolean> {
    try {
      if (!this.isInitialIndexing) {
        console.log(`[indexer] Processing file: ${path.relative(this.root, filePath)}`);
      }

      // Check if file needs reindexing (optimization for unchanged files)
      if (skipIfUnchanged) {
        const needsUpdate = await this.fileNeedsReindex(filePath);
        if (!needsUpdate) {
          return false; // Skipped
        }
      }

      const record = await buildIndexedRecord(this.root, filePath);
      this.db.upsertFile(record);
      if (!this.isInitialIndexing) {
        console.log(
          `[indexer] Successfully indexed: ${path.relative(this.root, filePath)}`,
        );
      }
      return true; // Indexed
    } catch (error) {
      // Log and continue.
      console.error(`[indexer] Failed to index ${filePath}:`, error);
      return false;
    }
  }

  private async fileNeedsReindex(filePath: string): Promise<boolean> {
    try {
      const stats = await fs.stat(filePath);
      const relativePath = toRelative(filePath, this.root);
      const existing = this.db.getFile(relativePath);

      if (!existing) {
        return true; // New file
      }

      // Discovered records always need reindexing
      if (isDiscoveredRecord(existing)) {
        return true;
      }

      // Check if size or modification time changed
      const sizeChanged = existing.size !== stats.size;
      const mtimeChanged = existing.dateModified !== stats.mtime.toISOString();

      return sizeChanged || mtimeChanged;
    } catch {
      return true; // If error checking, reindex to be safe
    }
  }

  removeFile(filePath: string): void {
    const relative = toRelative(filePath, this.root);
    this.db.removeFile(relative);
  }

  listIndexedFiles(): IndexFileRecord[] {
    return this.db.listFiles();
  }

  getIndexedFile(pathRelative: string): IndexFileRecord | undefined {
    return this.db.getFile(toPosix(pathRelative));
  }

  async queryFiles<T extends Array<keyof AllMetadata> | undefined = undefined>(
    filter?: Filter,
    options?: QueryOptions<T>,
  ): Promise<QueryResult<T>> {
    return this.db.queryFiles(filter, options);
  }

  // Phase 1: Discovery - just register filenames from directory walking
  private async discoverFiles(): Promise<void> {
    console.log(`[indexer] Phase 1: Discovering files in ${this.root}`);

    let discoveredCount = 0;
    let registeredCount = 0;
    let lastLogTime = Date.now();

    try {
      for await (const file of walkFiles(this.root)) {
        discoveredCount++;

        const wasRegistered = this.registerDiscoveredFile(file);
        if (wasRegistered) {
          registeredCount++;
        }

        // Update display every file or every 1 second, whichever is less frequent
        const now = Date.now();
        if (now - lastLogTime > 1000 || discoveredCount % 100 === 0) {
          const relativePath = path.relative(this.root, file);
          const displayPath =
            relativePath.length > 60 ? "..." + relativePath.slice(-57) : relativePath;
          process.stdout.write(
            `\r\x1b[K[indexer] Discovered ${discoveredCount} files (${registeredCount} new) — current: ${displayPath}`,
          );
          lastLogTime = now;
        }
      }
    } catch (error) {
      console.error(`[indexer] Error during file discovery:`, error);
    }

    process.stdout.write("\n");
    console.log(
      `[indexer] Phase 1 complete: ${discoveredCount} total, ${registeredCount} new files registered`,
    );
  }

  // Phase 2: Process all discovered files (gather file info + extract metadata in one pass)
  private async processDiscoveredFiles(): Promise<void> {
    console.log(`[indexer] Phase 2: Processing discovered files`);

    const files = this.db
      .listFiles()
      .filter((f): f is DiscoveredFileRecord => isDiscoveredRecord(f));

    if (files.length === 0) {
      console.log(`[indexer] Phase 2 complete: No files to process`);
      return;
    }

    console.log(`[indexer] Processing ${files.length} files`);

    this.isInitialIndexing = true;
    const total = files.length;
    const concurrency = 20; // Balanced concurrency for full processing
    let processed = 0;
    let failed = 0;
    const startTime = Date.now();

    for (let i = 0; i < files.length; i += concurrency) {
      const batch = files.slice(i, i + concurrency);
      await Promise.all(
        batch.map(async (fileRecord) => {
          const filePath = path.join(this.root, fileRecord.relativePath);
          const success = await this.processFile(filePath);
          if (success) {
            processed++;
          } else {
            failed++;
          }

          this.displayProgress(processed + failed, total, processed, failed, startTime);
        }),
      );
    }

    process.stdout.write("\n");
    this.isInitialIndexing = false;
    console.log(
      `[indexer] Phase 2 complete: ${processed} processed, ${failed} failed, ${total} total`,
    );
  }

  // Helper: Register a discovered file (state 1: discovered)
  private registerDiscoveredFile(filePath: string): boolean {
    try {
      const relativePath = toRelative(filePath, this.root);
      const existing = this.db.getFile(relativePath);

      // Skip if already exists
      if (existing) {
        return false;
      }

      // Create stub record with only filename-based info
      const mimeType = mimeTypeForFilename(path.basename(filePath));

      const stub: DiscoveredFileRecord = {
        relativePath,
        mimeType: mimeType ?? null,
        lastIndexedAt: null,
      };

      this.db.upsertFile(stub);
      return true;
    } catch (error) {
      console.error(`[indexer] Failed to register ${filePath}:`, error);
      return false;
    }
  }

  // Helper: Process a single file (gather file info + extract full metadata)
  private async processFile(filePath: string): Promise<boolean> {
    try {
      // buildIndexedRecord does both stat() and metadata extraction
      const record = await buildIndexedRecord(this.root, filePath);
      this.db.upsertFile(record);
      return true;
    } catch (error) {
      console.error(`[indexer] Failed to process ${filePath}:`, error);
      return false;
    }
  }

  private progressLastDisplayed = 0;

  // Helper: Display progress bar
  private displayProgress(
    completed: number,
    total: number,
    processed: number,
    failed: number,
    startTime: number,
  ): void {
    if (Date.now() - this.progressLastDisplayed < 200 && completed !== total) {
      return; // Throttle updates to every 200ms
    }
    this.progressLastDisplayed = Date.now();
    const percentage = Math.round((completed / total) * 100 * 10) / 10;
    const barWidth = 30;
    const filledWidth = Math.round((completed / total) * barWidth);
    const bar = "█".repeat(filledWidth) + "─".repeat(barWidth - filledWidth);
    const rate =
      processed > 0 ? (processed / ((Date.now() - startTime) / 1000)).toFixed(2) : "0.00";
    const eta =
      completed > 0 && completed < total
        ? this.formatTime(
            (total - completed) / (completed / ((Date.now() - startTime) / 1000)),
          )
        : "00:00:00";

    const failInfo = failed > 0 ? ` (${failed} failed)` : "";
    process.stdout.write(
      `\r\x1b[K[indexer] ${completed}/${total} ${percentage}% |${bar}| ETA ${eta} (${rate} f/s)${failInfo}`,
    );
  }

  private formatTime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }

  private async startWatcher(): Promise<void> {
    const watcher = chokidar.watch(this.root, {
      ignoreInitial: true,
      awaitWriteFinish: this.options.awaitWriteFinish
        ? { stabilityThreshold: 200, pollInterval: 100 }
        : false,
    });

    watcher.on("add", (filePath: string) => this.indexFile(filePath));
    watcher.on("change", (filePath: string) => this.indexFile(filePath));
    watcher.on("unlink", (filePath: string) => this.removeFile(filePath));
    watcher.on("error", (error) => {
      console.error("[indexer] watcher error", error);
    });

    await new Promise<void>((resolve) => {
      watcher.on("ready", () => resolve());
    });

    this.watcher = watcher;
  }
}

const toRelative = (filePath: string, root: string): string => {
  const absolute = path.resolve(filePath);
  if (!absolute.startsWith(root)) {
    throw new Error(`File ${filePath} is outside of watched root ${root}`);
  }
  const relative = path.relative(root, absolute);
  return toPosix(relative);
};

const toPosix = (relativePath: string): string => relativePath.split(path.sep).join("/");

async function* walkFiles(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    console.error(`[indexer] Error reading directory ${dir}:`, error);
    return; // Skip this directory
  }

  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name);

    try {
      if (entry.isDirectory()) {
        yield* walkFiles(absolutePath);
      } else if (entry.isFile()) {
        yield absolutePath;
      } else {
        // Skip unknown file types (symlinks, sockets, etc.) instead of throwing
        console.warn(`[indexer] Skipping non-file entry: ${absolutePath}`);
      }
    } catch (error) {
      console.error(`[indexer] Error processing ${absolutePath}:`, error);
      // Continue with next entry
    }
  }
}
