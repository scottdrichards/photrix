import { stat } from "node:fs/promises";
import type { AsyncSqlite } from "../common/asyncSqlite.ts";
import { config } from "../config/config.ts";
import { getLogger } from "../observability/logger.ts";
import type { QueryOptions } from "./indexDatabase.type.ts";

const log = getLogger("IndexDatabase");

/**
 * Housekeeping that isn't about any one table: the WAL checkpoint timer,
 * VACUUM / disk-size reporting, and the `settings` key/value rows.
 */
export class MaintenanceStore {
  private walCheckpointTimer?: ReturnType<typeof setInterval>;
  // Cached decode of the `settings` row for the default exclusion filter
  // (feedback #95) — read on nearly every /api/files request, so this avoids
  // a DB round trip + JSON.parse per request. `undefined` means "not loaded
  // yet"; `null` means "loaded, no filter set". Invalidated by
  // setDefaultExclusionFilter.
  private defaultExclusionFilterCache: QueryOptions["filter"] | null | undefined =
    undefined;

  constructor(
    private readonly db: AsyncSqlite,
    private readonly dbFilePath: string,
  ) {}

  // Passive autocheckpoints (wal_autocheckpoint) abort whenever a reader holds a
  // snapshot. The dedicated read connection services a near-constant stream of
  // background queries, so passive checkpoints get starved and the WAL grows
  // without bound (observed at ~1 GB). A periodic TRUNCATE checkpoint on the
  // write connection writes committed frames back into the main DB and resets
  // the WAL file during the gaps between readers.
  startWalMaintenance(): void {
    const intervalMs = config().db.walCheckpointIntervalMs;
    if (intervalMs === 0) return;
    this.walCheckpointTimer = setInterval(() => {
      void this.checkpointWal();
    }, intervalMs);
    this.walCheckpointTimer.unref?.();
  }

  /** Stops the periodic checkpoint timer. */
  stopWalMaintenance(): void {
    if (this.walCheckpointTimer) clearInterval(this.walCheckpointTimer);
    this.walCheckpointTimer = undefined;
  }

  /**
   * Write back reclaimable WAL frames and physically truncate the WAL file.
   *
   * TRUNCATE mode checkpoints all frames AND resets the WAL write position to
   * frame 0, but only if no reader holds a WAL snapshot at that moment. The
   * long-lived read worker holds an SHM lock for the lifetime of its
   * connection, so TRUNCATE is blocked whenever the read worker is mid-query.
   * Retrying with short gaps gives the checkpoint a window between read-query
   * batches (which last milliseconds) to grab the lock and physically shrink
   * the file. Without physical truncation, SQLite keeps the WAL at its peak
   * high-water mark even after all frames are checkpointed.
   */
  async checkpointWal(): Promise<void> {
    const maxAttempts = 5;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const result = await this.db.getFromWriteWorker<{
          busy: number;
          log: number;
          checkpointed: number;
        }>("PRAGMA wal_checkpoint(TRUNCATE)");
        if (result && result.busy === 0) return;
      } catch (err) {
        log.warn({ err }, "WAL checkpoint failed");
        return;
      }
      if (attempt < maxAttempts - 1) {
        await new Promise<void>((r) => setTimeout(r, 50));
      }
    }
  }

  async optimize(): Promise<void> {
    await this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    await this.db.exec("PRAGMA optimize");
    await this.db.exec("VACUUM");
  }

  async getOnDiskSize(): Promise<{
    mainDb: number;
    walFile: number;
    shmFile: number;
    total: number;
  }> {
    const getFileSize = async (filePath: string): Promise<number> => {
      try {
        const fileStat = await stat(filePath);
        return fileStat.size;
      } catch {
        return 0;
      }
    };

    const [mainDb, walFile, shmFile] = await Promise.all([
      getFileSize(this.dbFilePath),
      getFileSize(`${this.dbFilePath}-wal`),
      getFileSize(`${this.dbFilePath}-shm`),
    ]);

    return { mainDb, walFile, shmFile, total: mainDb + walFile + shmFile };
  }

  /**
   * The user's standing "hide these by default" filter (feedback #95) —
   * e.g. a specific face cluster or folder they want excluded from the main
   * gallery/grid/map/people views unless explicitly overridden per-request.
   * Cached in memory (see `defaultExclusionFilterCache`) so the common path
   * — every /api/files request — costs no DB round trip; only
   * `setDefaultExclusionFilter` invalidates it.
   */
  async getDefaultExclusionFilter(): Promise<QueryOptions["filter"] | null> {
    if (this.defaultExclusionFilterCache !== undefined) {
      return this.defaultExclusionFilterCache;
    }
    const row = await this.db.get<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'defaultExclusionFilter'",
    );
    let parsed: QueryOptions["filter"] | null = null;
    if (row?.value) {
      try {
        parsed = JSON.parse(row.value) as QueryOptions["filter"];
      } catch {
        parsed = null;
      }
    }
    this.defaultExclusionFilterCache = parsed;
    return parsed;
  }

  /** Sets (or, with `null`, clears) the default exclusion filter and drops the cache. */
  async setDefaultExclusionFilter(filter: QueryOptions["filter"] | null): Promise<void> {
    if (filter === null) {
      await this.db.run("DELETE FROM settings WHERE key = 'defaultExclusionFilter'");
    } else {
      await this.db.run(
        "INSERT INTO settings (key, value) VALUES ('defaultExclusionFilter', ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        JSON.stringify(filter),
      );
    }
    this.defaultExclusionFilterCache = filter;
  }
}
