import { watch, existsSync } from "node:fs";
import { EventEmitter } from "node:events";

// One EventEmitter per HLS directory, firing "change" whenever any file in the tree changes.
const watchers = new Map<string, EventEmitter>();

const getOrCreateWatcher = (hlsDir: string): EventEmitter => {
  const existing = watchers.get(hlsDir);
  if (existing) return existing;

  const emitter = new EventEmitter();
  emitter.setMaxListeners(0); // unlimited — one listener per waiting segment/playlist request

  watch(hlsDir, { recursive: true }, () => {
    emitter.emit("change");
  });

  watchers.set(hlsDir, emitter);
  return emitter;
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
