import { promises as fs } from "fs";
import path from "path";
import chokidar, { FSWatcher } from "chokidar";
import { IndexDatabase } from "./indexDatabase.js";
import { buildIndexedRecord } from "./metadata.js";
import type { IndexedFileRecord } from "./models.js";
import type { AllMetadata, Filter } from "../apiSpecification.js";
import type { QueryOptions, QueryResult } from "./indexDatabase.js";

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
    await this.indexExistingFiles();
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

  async indexFile(filePath: string): Promise<void> {
    try {
      if (!this.isInitialIndexing) {
        console.log(`[indexer] Processing file: ${path.relative(this.root, filePath)}`);
      }
      const record = await buildIndexedRecord(this.root, filePath);
      this.db.upsertFile(record);
      if (!this.isInitialIndexing) {
        console.log(
          `[indexer] Successfully indexed: ${path.relative(this.root, filePath)}`,
        );
      }
    } catch (error) {
      // Log and continue.
      console.error(`[indexer] Failed to index ${filePath}:`, error);
    }
  }

  removeFile(filePath: string): void {
    const relative = this.toRelative(filePath);
    this.db.removeFile(relative);
  }

  listIndexedFiles(): IndexedFileRecord[] {
    return this.db.listFiles();
  }

  getIndexedFile(pathRelative: string): IndexedFileRecord | undefined {
    return this.db.getFile(this.toPosix(pathRelative));
  }

  async queryFiles<T extends Array<keyof AllMetadata> | undefined = undefined>(
    filter?: Filter,
    options?: QueryOptions<T>,
  ): Promise<QueryResult<T>> {
    return this.db.queryFiles(filter, options);
  }

  private async indexExistingFiles(): Promise<void> {
    console.log(`[indexer] Starting to index existing files in ${this.root}`);
    
    const files: string[] = [];
    let discoveredCount = 0;
    
    // Collect files with live progress
    for await (const file of walkFiles(this.root)) {
      files.push(file);
      discoveredCount++;
      const relativePath = path.relative(this.root, file);
      const displayPath = relativePath.length > 60 
        ? "..." + relativePath.slice(-57) 
        : relativePath;
      // Clear line and write status
      process.stdout.write(
        `\r\x1b[K[indexer] Scanned ${discoveredCount} files — current: ${displayPath}`,
      );
    }
    
    process.stdout.write("\n");
    console.log(`[indexer] Found ${files.length} files to index`);

    // Process files sequentially with progress
    this.isInitialIndexing = true;
    let indexed = 0;
    const total = files.length;
    const barWidth = 30;
    const startTime = Date.now();
    
    for (const file of files) {
      await this.indexFile(file);
      indexed++;
      
      const percentage = Math.round((indexed / total) * 100 * 10) / 10;
      const filledWidth = Math.round((indexed / total) * barWidth);
      const bar = "█".repeat(filledWidth) + "─".repeat(barWidth - filledWidth);
      const rate = indexed > 0 ? (indexed / ((Date.now() - startTime) / 1000)).toFixed(2) : "0.00";
      const eta = indexed > 0 && indexed < total
        ? this.formatTime((total - indexed) / (indexed / ((Date.now() - startTime) / 1000)))
        : "00:00:00";
      
      // Clear line and write progress
      process.stdout.write(
        `\r\x1b[K[indexer] ${indexed}/${total} ${percentage}% |${bar}| ETA ${eta} (${rate} f/s)`,
      );
    }
    
    process.stdout.write("\n");
    this.isInitialIndexing = false;
    console.log(`[indexer] Completed indexing ${files.length} files`);
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

  private toRelative(filePath: string): string {
    const absolute = path.resolve(filePath);
    if (!absolute.startsWith(this.root)) {
      throw new Error(`File ${filePath} is outside of watched root ${this.root}`);
    }
    const relative = path.relative(this.root, absolute);
    return this.toPosix(relative);
  }

  private toPosix(relativePath: string): string {
    return relativePath.split(path.sep).join("/");
  }
}


async function* walkFiles(dir: string): AsyncGenerator<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(absolutePath);
    } else if (entry.isFile()) {
      yield absolutePath;
    } else {
      throw new Error(`Unknown file type: ${absolutePath}`);
    }
  }
}
