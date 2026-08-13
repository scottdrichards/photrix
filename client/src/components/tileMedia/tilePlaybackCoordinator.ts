/**
 * Global arbiter for every moving picture in the thumbnail grid.
 *
 * The grid can have thousands of tiles mounted, and each one that starts playing
 * costs bytes on a metered link and — for transcoded video — time on a GPU the
 * server shares with its ML workers. So no tile is allowed to start playing on
 * its own: it must take a slot from here, and it must accept being stopped again
 * at any moment. Everything in this module is about making "stop" cheap,
 * immediate and impossible to miss.
 *
 * Two pools, because the two kinds of playback have very different costs:
 *   - "video"  — hover-to-play video tiles. Capacity 1. Newest hover wins and
 *                evicts the previous one, so at most one video stream is ever in
 *                flight from the grid.
 *   - "ambient"— live-photo motion clips (small, local, already-cached files).
 *                Capacity 2, so the grid feels alive without becoming a wall of
 *                motion.
 *
 * Playback is globally suspended while the tab is hidden, and the ambient
 * rotation additionally respects prefers-reduced-motion and Save-Data.
 */

export type PlaybackPool = "video" | "ambient";

const POOL_CAPACITY: Record<PlaybackPool, number> = {
  video: 1,
  ambient: 2,
};

/** How often the ambient rotation considers waking a live photo up. */
const AMBIENT_TICK_MS = 4500;
/** Random extra delay per tick so the grid doesn't pulse in lockstep. */
const AMBIENT_JITTER_MS = 3000;

type Holder = {
  stop: () => void;
  released: boolean;
};

const pools: Record<PlaybackPool, Holder[]> = {
  video: [],
  ambient: [],
};

const ambientCandidates = new Set<() => void>();
let ambientTimer: ReturnType<typeof setTimeout> | null = null;
let listenersAttached = false;

// A shuffled walk through the current candidate set, rebuilt whenever it's
// exhausted (or a fresh candidate set makes the old order stale). This is
// what stops the idle rotation from re-picking the same live photo twice in
// a row, which plain per-tick Math.random() selection could do.
let ambientPlaylist: (() => void)[] = [];
let ambientPlaylistCursor = 0;

const shuffle = <T,>(items: T[]): T[] => {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
};

/**
 * Pull the next candidate off the playlist, reshuffling from the live
 * candidate set once it runs dry. Entries for candidates that unregistered
 * since the playlist was built are skipped rather than played.
 */
const nextAmbientCandidate = (): (() => void) | undefined => {
  while (ambientPlaylistCursor < ambientPlaylist.length) {
    const candidate = ambientPlaylist[ambientPlaylistCursor++];
    if (ambientCandidates.has(candidate)) return candidate;
  }

  if (ambientCandidates.size === 0) return undefined;

  const previous = ambientPlaylist[ambientPlaylist.length - 1];
  const shuffled = shuffle([...ambientCandidates]);
  // Don't let a fresh shuffle immediately replay whatever just finished.
  if (shuffled.length > 1 && shuffled[0] === previous) {
    [shuffled[0], shuffled[1]] = [shuffled[1], shuffled[0]];
  }
  ambientPlaylist = shuffled;
  ambientPlaylistCursor = 1;
  return ambientPlaylist[0];
};

export const prefersReducedMotion = (): boolean => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
};

const prefersReducedData = (): boolean => {
  const connection = (
    navigator as Navigator & { connection?: { saveData?: boolean } }
  ).connection;
  return connection?.saveData === true;
};

const isTabHidden = (): boolean =>
  typeof document !== "undefined" && document.visibilityState === "hidden";

/** Any playback at all — user-initiated hover included — is off while hidden. */
export const isPlaybackAllowed = (): boolean => !isTabHidden();

/**
 * Unattended motion (the idle live-photo rotation) additionally backs off for
 * users who asked for less motion or less data. Hover previews are deliberate,
 * so they are not gated on these.
 */
export const isAmbientPlaybackAllowed = (): boolean =>
  isPlaybackAllowed() && !prefersReducedMotion() && !prefersReducedData();

const removeHolder = (pool: PlaybackPool, holder: Holder): void => {
  const index = pools[pool].indexOf(holder);
  if (index !== -1) pools[pool].splice(index, 1);
};

/**
 * Stop a holder and drop it from its pool. Safe to call more than once and safe
 * to call re-entrantly from inside the holder's own stop callback — the
 * `released` latch is what lets teardown paths converge without looping.
 */
const evict = (pool: PlaybackPool, holder: Holder): void => {
  if (holder.released) return;
  holder.released = true;
  removeHolder(pool, holder);
  holder.stop();
};

const stopEverything = (): void => {
  for (const pool of Object.keys(pools) as PlaybackPool[]) {
    // Copy first: each stop() mutates the pool as it releases its slot.
    for (const holder of [...pools[pool]]) evict(pool, holder);
  }
};

/**
 * Reserve the right to play. Returns a release function, or null when the
 * request could not be satisfied (tab hidden, or the pool is full of holders
 * that may not be preempted).
 *
 * `stop` must synchronously halt playback and release every network resource
 * the tile holds. It is called when something more important takes the slot,
 * when the tab is hidden, or on page teardown.
 */
export const acquirePlaybackSlot = (
  pool: PlaybackPool,
  stop: () => void,
  options: { preempt?: boolean } = {},
): (() => void) | null => {
  if (!isPlaybackAllowed()) return null;
  ensureGlobalListeners();

  const { preempt = true } = options;
  const holders = pools[pool];

  if (holders.length >= POOL_CAPACITY[pool]) {
    if (!preempt) return null;
    // Oldest first: the tile that has already had its turn yields.
    evict(pool, holders[0]);
  }

  const holder: Holder = { stop, released: false };
  holders.push(holder);
  return () => {
    holder.released = true;
    removeHolder(pool, holder);
  };
};

/**
 * Offer a tile up to the idle rotation. `play` is invoked at most once per tick
 * and is expected to acquire its own ambient slot (and to no-op if it can't).
 * Returns an unregister function.
 */
export const registerAmbientCandidate = (play: () => void): (() => void) => {
  ensureGlobalListeners();
  ambientCandidates.add(play);
  scheduleAmbientTick();
  return () => {
    ambientCandidates.delete(play);
    if (ambientCandidates.size === 0) cancelAmbientTick();
  };
};

const cancelAmbientTick = (): void => {
  if (ambientTimer === null) return;
  clearTimeout(ambientTimer);
  ambientTimer = null;
};

const scheduleAmbientTick = (): void => {
  if (ambientTimer !== null) return;
  if (ambientCandidates.size === 0) return;
  if (!isAmbientPlaybackAllowed()) return;
  ambientTimer = setTimeout(runAmbientTick, AMBIENT_TICK_MS + Math.random() * AMBIENT_JITTER_MS);
};

const runAmbientTick = (): void => {
  ambientTimer = null;
  if (!isAmbientPlaybackAllowed()) return;

  if (pools.ambient.length < POOL_CAPACITY.ambient) {
    nextAmbientCandidate()?.();
  }
  scheduleAmbientTick();
};

const handleVisibilityChange = (): void => {
  if (isTabHidden()) {
    // Hard stop: a backgrounded tab must not hold a transcode session open or
    // keep pulling segments the user cannot see.
    cancelAmbientTick();
    stopEverything();
  } else {
    scheduleAmbientTick();
  }
};

const ensureGlobalListeners = (): void => {
  if (listenersAttached || typeof document === "undefined") return;
  listenersAttached = true;
  document.addEventListener("visibilitychange", handleVisibilityChange);
  // pagehide covers bfcache and mobile Safari tab switches, where
  // visibilitychange alone is not reliable.
  window.addEventListener("pagehide", stopEverything);
};

export const __resetTilePlaybackCoordinatorForTests = (): void => {
  stopEverything();
  cancelAmbientTick();
  ambientCandidates.clear();
  pools.video.length = 0;
  pools.ambient.length = 0;
  ambientPlaylist = [];
  ambientPlaylistCursor = 0;
};
