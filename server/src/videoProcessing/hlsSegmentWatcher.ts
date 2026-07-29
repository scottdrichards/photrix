import { watch, existsSync, type FSWatcher } from "node:fs";
import { EventEmitter } from "node:events";
import { getLogger } from "../observability/logger.ts";

const log = getLogger("HLS");

/**
 * Safety-net re-check interval for waiters.
 *
 * fs.watch is best-effort: events can be dropped, and the watcher can die
 * outright (see below). Polling on top of it means a waiter's correctness never
 * depends on the watcher — the watcher only makes it fast.
 */
const POLL_MS = 250;

type WatchEntry = { emitter: EventEmitter; watcher?: FSWatcher };

// One EventEmitter + FSWatcher per HLS directory, firing "change" whenever any
// file in the tree changes.
const watchers = new Map<string, WatchEntry>();

/** Closes a watcher handle without ever letting close() itself throw. */
const closeQuietly = (watcher: FSWatcher | undefined): void => {
  if (!watcher) return;
  try {
    watcher.close();
  } catch {
    // Already closed / handle gone — nothing to do.
  }
};

const getOrCreateWatcher = (hlsDir: string): EventEmitter => {
  const existing = watchers.get(hlsDir);
  if (existing) return existing.emitter;

  const emitter = new EventEmitter();
  emitter.setMaxListeners(0); // unlimited — one listener per waiting segment/playlist request
  const entry: WatchEntry = { emitter };
  watchers.set(hlsDir, entry);

  // A recursive fs.watch walks the tree itself and re-scans a directory
  // (readdirSync) whenever it sees an event on it. Variant directories are
  // volatile — an encode restart clears its variant directory, the idle reaper
  // deletes the whole tree, a resync drops the mirrored cache — so that re-scan
  // can hit a directory that has just been removed and throw ENOENT. Node reports
  // it by emitting "error" on the watcher, and an EventEmitter "error" with no
  // listener is rethrown, which is what took the whole server down with
  // "FATAL Uncaught exception ... ENOENT scandir .../hls/abr/1080p".
  //
  // So: never create a watcher without an error listener, and treat watcher death
  // as a downgrade (waiters fall back to polling), never as a failure.
  try {
    const watcher = watch(hlsDir, { recursive: true }, () => {
      emitter.emit("change");
    });

    watcher.on("error", (err: unknown) => {
      // Drop this watcher so a later request can build a fresh one (e.g. once the
      // tree is re-created), and wake current waiters so they re-check now.
      if (watchers.get(hlsDir) === entry) watchers.delete(hlsDir);
      entry.watcher = undefined;
      closeQuietly(watcher);
      log.debug({ err, hlsDir }, "HLS watcher error — falling back to polling");
      emitter.emit("change");
    });

    entry.watcher = watcher;
  } catch (err) {
    // The directory may not exist (yet). Waiters still work via polling.
    watchers.delete(hlsDir);
    log.debug({ err, hlsDir }, "Could not watch HLS directory — falling back to polling");
  }

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
  closeQuietly(existing.watcher);
  // In-flight waiters lose push notification here, but their poll notices the tree
  // is gone within POLL_MS and gives up rather than hanging for the full timeout.
  existing.emitter.removeAllListeners();
};

/**
 * Closes every watcher at or below `directory`. Callers that delete a whole
 * subtree (the mirrored cache for a file, which contains the `abr` tree the
 * watchers are actually keyed on) use this so no watcher is left pointing into
 * a directory that is being removed.
 */
export const closeHlsWatchersUnder = (directory: string): void => {
  const prefix = directory.endsWith("/") ? directory : `${directory}/`;
  for (const hlsDir of [...watchers.keys()]) {
    if (hlsDir === directory || hlsDir.startsWith(prefix)) closeHlsWatcher(hlsDir);
  }
};

/**
 * Resolves true when absoluteFilePath exists within timeoutMs, false on timeout
 * or once the HLS directory itself has gone away (reaped mid-wait — nothing is
 * going to produce the file any more).
 *
 * Uses fs.watch for push-based notification: when FFmpeg writes a new segment or
 * playlist file to the HLS directory, all waiting request handlers are immediately
 * notified and each checks whether its specific file is now available. A slow poll
 * backs it up so a dropped event or a dead watcher can't strand a request.
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
      clearInterval(poll);
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

    const poll = setInterval(() => {
      if (existsSync(absoluteFilePath)) {
        cleanup(true);
        return;
      }
      // Tree reaped (or never created): fail fast instead of holding the request
      // open for the full timeout waiting on an encode that no longer exists.
      if (!existsSync(hlsDir)) cleanup(false);
    }, POLL_MS);
    poll.unref?.();

    emitter.on("change", handler);
  });
};
