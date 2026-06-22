import { watch, existsSync, type FSWatcher } from "node:fs";
import { EventEmitter } from "node:events";

// One EventEmitter + FSWatcher per HLS directory, firing "change" whenever any
// file in the tree changes.
const watchers = new Map<string, { emitter: EventEmitter; watcher: FSWatcher }>();

const getOrCreateWatcher = (hlsDir: string): EventEmitter => {
  const existing = watchers.get(hlsDir);
  if (existing) return existing.emitter;

  const emitter = new EventEmitter();
  emitter.setMaxListeners(0); // unlimited — one listener per waiting segment/playlist request

  const watcher = watch(hlsDir, { recursive: true }, () => {
    emitter.emit("change");
  });

  watchers.set(hlsDir, { emitter, watcher });
  return emitter;
};

/**
 * Closes and forgets the watcher for an HLS directory. Call this before deleting
 * the directory so the underlying fs.watch handle doesn't leak on a stale path.
 */
export const closeHlsWatcher = (hlsDir: string): void => {
  const existing = watchers.get(hlsDir);
  if (!existing) return;
  watchers.delete(hlsDir);
  existing.watcher.close();
  existing.emitter.removeAllListeners();
};

/**
 * Resolves true when absoluteFilePath exists within timeoutMs, false on timeout.
 *
 * Uses fs.watch for push-based notification: when FFmpeg writes a new segment or
 * playlist file to the HLS directory, all waiting request handlers are immediately
 * notified and each checks whether its specific file is now available.
 */
export const waitForHlsFile = (
  hlsDir: string,
  absoluteFilePath: string,
  timeoutMs = 60_000,
): Promise<boolean> => {
  if (existsSync(absoluteFilePath)) return Promise.resolve(true);

  return new Promise((resolve) => {
    const emitter = getOrCreateWatcher(hlsDir);

    let resolved = false;
    const cleanup = (result: boolean) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      emitter.off("change", handler);
      resolve(result);
    };

    const timer = setTimeout(() => {
      // Final check before declaring timeout
      cleanup(existsSync(absoluteFilePath));
    }, timeoutMs);

    const handler = () => {
      if (existsSync(absoluteFilePath)) {
        cleanup(true);
      }
    };

    emitter.on("change", handler);
  });
};
