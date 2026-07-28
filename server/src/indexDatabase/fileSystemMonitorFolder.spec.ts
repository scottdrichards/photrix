import { afterEach, describe, expect, it } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import { promises as fs, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FileRecord } from "./fileRecord.type.ts";
import { fileSystemMonitorFolder } from "./fileSystemMonitorFolder.ts";
import type { IndexDatabase } from "./indexDatabase.ts";

// Poll a predicate until it holds (or throws). fs.watch delivery is inherently
// asynchronous and lightly batched, so tests observe effects rather than timing.
const waitFor = async (
  predicate: () => boolean,
  { timeoutMs = 4000, intervalMs = 20 } = {},
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
};

type Call = { method: string; args: unknown[] };

/**
 * Minimal in-memory stand-in for IndexDatabase that records the calls the
 * monitor makes and can be pre-seeded with file fingerprints so move/delete
 * pairing and change detection have something to compare against.
 */
const createFakeDb = (storagePath: string) => {
  const calls: Call[] = [];
  const records = new Map<string, FileRecord>();
  const record = (method: string, ...args: unknown[]) => calls.push({ method, args });

  const seedFromDisk = (relativePath: string) => {
    const stats = statSync(path.join(storagePath, relativePath));
    records.set(relativePath, {
      folder: path.dirname(relativePath),
      fileName: path.basename(relativePath),
      mimeType: "text/plain",
      sizeInBytes: stats.size,
      // Mirror processFileInfo's `new Date(mtimeMs)` so the stored fingerprint
      // matches the one the monitor derives from a live stat.
      modified: new Date(stats.mtimeMs),
    } as FileRecord);
  };

  const db = {
    storagePath,
    getFileRecord: (relativePath: string) => {
      record("getFileRecord", relativePath);
      return Promise.resolve(records.get(relativePath));
    },
    addPaths: (paths: string[]) => {
      record("addPaths", paths);
      return Promise.resolve();
    },
    moveFile: (oldPath: string, newPath: string) => {
      record("moveFile", oldPath, newPath);
      const existing = records.get(oldPath);
      const existed = records.delete(oldPath);
      if (existing) records.set(newPath, existing);
      return Promise.resolve(existed);
    },
    removeFile: (relativePath: string) => {
      record("removeFile", relativePath);
      return Promise.resolve(records.delete(relativePath));
    },
    removeFolder: (relativePath: string) => {
      record("removeFolder", relativePath);
      return Promise.resolve();
    },
    markFileForResync: (relativePath: string) => {
      record("markFileForResync", relativePath);
      return Promise.resolve(records.has(relativePath));
    },
  } as unknown as IndexDatabase;

  const callsTo = (method: string) => calls.filter((c) => c.method === method);
  return { db, calls, callsTo, seedFromDisk };
};

describe("fileSystemMonitorFolder", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  const startMonitor = (options: Parameters<typeof fileSystemMonitorFolder>[1] = {}) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "photrix-monitor-"));
    const fake = createFakeDb(root);
    const stop = fileSystemMonitorFolder(fake.db, options);
    cleanups.push(() => {
      stop();
      rmSync(root, { recursive: true, force: true });
    });
    return { root, ...fake };
  };

  it("registers a newly created file and wakes the pipeline", async () => {
    let changes = 0;
    const { root, callsTo } = startMonitor({ onChange: () => changes++ });

    await fs.writeFile(path.join(root, "new.txt"), "hello");

    await waitFor(() => callsTo("addPaths").length > 0);
    expect(callsTo("addPaths")[0]!.args[0]).toEqual(["new.txt"]);
    expect(changes).toBeGreaterThan(0);
  });

  it("re-syncs an indexed file when its content changes", async () => {
    let changes = 0;
    const monitor = startMonitor({ onChange: () => changes++, changeSettleMs: 50 });
    const filePath = path.join(monitor.root, "photo.txt");

    // Create and index the file, then let the initial create event settle.
    await fs.writeFile(filePath, "v1");
    await waitFor(() => monitor.callsTo("addPaths").length > 0);
    monitor.seedFromDisk("photo.txt");

    // Edit in place with a newer mtime so the fingerprint differs.
    await new Promise((r) => setTimeout(r, 30));
    await fs.writeFile(filePath, "a much longer second version");

    await waitFor(() => monitor.callsTo("markFileForResync").length > 0);
    expect(monitor.callsTo("markFileForResync")[0]!.args[0]).toBe("photo.txt");
  });

  it("tracks a rename as a move rather than delete + add", async () => {
    const monitor = startMonitor();
    const oldPath = path.join(monitor.root, "before.txt");

    await fs.writeFile(oldPath, "content");
    await waitFor(() => monitor.callsTo("addPaths").length > 0);
    monitor.seedFromDisk("before.txt");

    await fs.rename(oldPath, path.join(monitor.root, "after.txt"));

    await waitFor(() => monitor.callsTo("moveFile").length > 0);
    const moveCall = monitor.callsTo("moveFile")[0]!;
    expect(moveCall.args).toEqual(["before.txt", "after.txt"]);
    // A move must not fall through to a destructive removeFile of the source.
    expect(monitor.callsTo("removeFile")).toHaveLength(0);
  });

  it("removes a file that is deleted from disk", async () => {
    const monitor = startMonitor();
    const filePath = path.join(monitor.root, "gone.txt");

    await fs.writeFile(filePath, "temp");
    await waitFor(() => monitor.callsTo("addPaths").length > 0);
    monitor.seedFromDisk("gone.txt");

    await fs.rm(filePath);

    // The delete is buffered briefly to pair with a possible move; with no
    // matching create it commits as a removal.
    await waitFor(() => monitor.callsTo("removeFile").length > 0, { timeoutMs: 5000 });
    expect(monitor.callsTo("removeFile")[0]!.args[0]).toBe("gone.txt");
  });
});
