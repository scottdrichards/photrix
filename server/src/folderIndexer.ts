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

const DEFAULT_OPTIONS: Required<Pick<FolderIndexerOptions, "watch" | "awaitWriteFinish">> = {
  watch: true,
  awaitWriteFinish: true,
};

export class FolderIndexer {
  private watcher: FSWatcher | null = null;
  private readonly db: IndexDatabase;
  private readonly options: typeof DEFAULT_OPTIONS & FolderIndexerOptions;
  private readonly root: string;

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
      console.log(`[indexer] Processing file: ${path.relative(this.root, filePath)}`);
      const record = await buildIndexedRecord(this.root, filePath);
      this.db.upsertFile(record);
      console.log(`[indexer] Successfully indexed: ${path.relative(this.root, filePath)}`);
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

  async queryFiles<
    T extends Array<keyof AllMetadata> | undefined = undefined
  >(
    filter?: Filter,
    options?: QueryOptions<T>
  ): Promise<QueryResult<T>> {
    return this.db.queryFiles(filter, options);
  }

  private async indexExistingFiles(): Promise<void> {
    console.log(`[indexer] Starting to index existing files in ${this.root}`);
    const files = await this.walkFiles(this.root);
    console.log(`[indexer] Found ${files.length} files to index`);
    
    // Process files sequentially to avoid overwhelming the system
    for (const file of files) {
      await this.indexFile(file);
    }
    
    console.log(`[indexer] Completed indexing ${files.length} files`);
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

  private async walkFiles(dir: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    
    const filePromises = entries.map(async (entry) => {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return await this.walkFiles(absolutePath);
      }
      return entry.isFile() ? [absolutePath] : [];
    });

    const results = await Promise.all(filePromises);
    return results.flat();
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
