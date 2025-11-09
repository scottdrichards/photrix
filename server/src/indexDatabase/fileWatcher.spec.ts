import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { FileWatcher } from "./fileWatcher.js";
import { IndexDatabase } from "./indexDatabase.js";
import type { DatabaseFileEntry } from "./fileRecord.type.js";

type WatchEvent = "add" | "change" | "unlink" | "error";
type WatchPayload = string | Error;
type WatchHandler = (payload: WatchPayload) => unknown;

type MockFsWatcher = {
  on: (event: WatchEvent, handler: WatchHandler) => MockFsWatcher;
  close: () => Promise<void>;
};

type MockWatcherEntry = {
  handlers: Record<WatchEvent, WatchHandler[]>;
  close: () => Promise<void>;
};

const watcherRegistry: MockWatcherEntry[] = [];

const createMockWatcher = (): MockFsWatcher => {
  const handlers: Record<WatchEvent, WatchHandler[]> = {
    add: [],
    change: [],
    unlink: [],
    error: [],
  };

  const close = async () => {
    const index = watcherRegistry.findIndex((entry) => entry.handlers === handlers);
    if (index !== -1) {
      watcherRegistry.splice(index, 1);
    }
  };

  const watcher: MockFsWatcher = {
    on(event, handler) {
      handlers[event].push(handler);
      return watcher;
    },
    close,
  };

  watcherRegistry.push({ handlers, close });
  return watcher;
};

const resetWatcherMocks = () => {
  watcherRegistry.length = 0;
};

const triggerWatcherEvent = async (event: WatchEvent, payload: WatchPayload): Promise<void> => {
  if (watcherRegistry.length === 0) {
    throw new Error("No active mock watchers");
  }

  const handlers = watcherRegistry.flatMap((entry) => entry.handlers[event]);
  await Promise.all(handlers.map((handler) => handler(payload)));
};

const flushAsyncTasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

jest.mock("chokidar", () => {
  const watch = (_path: string, _options?: unknown): MockFsWatcher => createMockWatcher();
  return {
    __esModule: true,
    default: { watch },
    watch,
  };
});

const createEntry = (relativePath: string): DatabaseFileEntry => ({
  relativePath,
  mimeType: "image/jpeg",
  info: {
    sizeInBytes: 64,
    created: new Date("2020-01-01T00:00:00Z"),
    modified: new Date("2020-01-01T00:00:00Z"),
  },
  exifMetadata: {},
  aiMetadata: {},
  faceMetadata: {},
});

describe("FileWatcher", () => {
  const MOVE_WINDOW_MS = 500;
  let tempDir: string;
  let db: IndexDatabase;
  let watcher: FileWatcher;
  let absoluteOriginal: string;

  beforeEach(async () => {
    resetWatcherMocks();
    jest.useFakeTimers();

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "photrix-watcher-"));
    absoluteOriginal = path.join(tempDir, "original.jpg");
    await fs.writeFile(absoluteOriginal, Buffer.alloc(64));
    const timestamp = new Date("2020-01-01T00:00:00Z");
    await fs.utimes(absoluteOriginal, timestamp, timestamp);

    db = new IndexDatabase(tempDir);
    await db.addFile(createEntry("original.jpg"));

    watcher = new FileWatcher(tempDir, db);
    watcher.startWatching();
  });

  afterEach(async () => {
    await watcher.stopWatching();
    resetWatcherMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it("queues metadata refresh on change events", async () => {
    const queueSpy = jest.spyOn(watcher, "addFileToJobQueue");

    await triggerWatcherEvent("change", absoluteOriginal);

    expect(queueSpy).toHaveBeenCalledWith("original.jpg");
    queueSpy.mockRestore();
  });

  it("removes entries when files are deleted", async () => {
    await triggerWatcherEvent("unlink", absoluteOriginal);

    jest.advanceTimersByTime(MOVE_WINDOW_MS + 10);
    await flushAsyncTasks();

    const record = await db.getFileRecord("original.jpg");
    expect(record).toBeUndefined();
  });

  it("detects files moved within the watched directory", async () => {
    const moveSpy = jest.spyOn(db, "moveFile");
    const queueSpy = jest.spyOn(watcher, "addFileToJobQueue");
    const determineSpy = jest.spyOn(
      watcher as unknown as {
        determineIfMoveAndCompleteMove: (
          newRelativePath: string,
          absolutePath: string,
        ) => Promise<boolean>;
      },
      "determineIfMoveAndCompleteMove",
    );

    await triggerWatcherEvent("unlink", absoluteOriginal);

    const movedPath = path.join(tempDir, "moved.jpg");
    await fs.rename(absoluteOriginal, movedPath);
    const timestamp = new Date("2020-01-01T00:00:00Z");
    await fs.utimes(movedPath, timestamp, timestamp);

    const internalWatcher = watcher as unknown as {
      pendingMoves: Map<
        string,
        {
          sizeInBytes?: number;
          modifiedTimeMs?: number;
        }
      >;
    };
    const pendingMove = internalWatcher.pendingMoves.get("original.jpg");
    if (pendingMove) {
      const stats = await fs.stat(movedPath);
      pendingMove.sizeInBytes = stats.size;
      pendingMove.modifiedTimeMs = undefined;
    }

    expect(internalWatcher.pendingMoves.size).toBe(1);

    await triggerWatcherEvent("add", movedPath);

    expect(determineSpy).toHaveBeenCalled();
    const { mock } = determineSpy as unknown as {
      mock: {
        results: Array<{
          type: "return" | "throw";
          value: Promise<boolean>;
        }>;
      };
    };
  const lastResult = mock.results[mock.results.length - 1];
  expect(lastResult?.type).toBe("return");
  await expect(lastResult?.value).resolves.toBe(true);
    expect(moveSpy).toHaveBeenCalledWith("original.jpg", "moved.jpg");

    const entries = (db as unknown as { entries: Record<string, DatabaseFileEntry> }).entries;
    expect(Object.keys(entries)).toContain("moved.jpg");
    expect(Object.keys(entries)).not.toContain("original.jpg");
    expect(entries["original.jpg"]).toBeUndefined();
    const oldRecord = await db.getFileRecord("original.jpg");
    const newRecord = await db.getFileRecord("moved.jpg");
    expect(oldRecord).toBeUndefined();
    expect(newRecord?.relativePath).toBe("moved.jpg");
    expect(queueSpy).not.toHaveBeenCalled();
    queueSpy.mockRestore();
  });
});