/**
 * A tiny FIFO gate for the grid's full-resolution ("sharp") thumbnail loads.
 *
 * Same shape as MapFilter.thumbnailQueue's gate for map pin thumbnails —
 * deliberately duplicated rather than shared, since the two callers admit at
 * different rates and evolving one must not silently retune the other.
 *
 * A tile only asks for its sharp 320 once it has dwelt in the close viewport
 * band (see ThumbnailTile's SHARP_DWELL_MS) or been explicitly hovered. That
 * gates a *fling* — a tile that only passes through the band never earns the
 * fetch — but it does nothing for a scroll that pauses, or simply moves at a
 * pace that keeps a screenful of tiles in the close band for longer than the
 * dwell: every one of those tiles' timers elapses within the same tick, and
 * without a gate every one of them fires its full-decode fetch in the same
 * frame. That simultaneous burst — not the fade, not the intersection
 * observer — is the reported "hangs like it's loading a bunch of images at
 * once". Admitting only a handful at a time smooths that into a steady
 * trickle instead of a burst, and — because a waiting entry can be revoked —
 * a tile that scrolls back out of the close band (or gets reused for a
 * different photo) before its turn never spends a slot on a picture nobody
 * is looking at.
 */

const MAX_CONCURRENT_LOADS = 6;

type Waiter = { start: () => void; revoked: boolean };

let activeLoads = 0;
const waiting: Waiter[] = [];

const pump = () => {
  while (activeLoads < MAX_CONCURRENT_LOADS) {
    const next = waiting.shift();
    if (!next) return;
    if (next.revoked) continue;
    activeLoads += 1;
    next.start();
  }
};

/**
 * Requests a load slot. `start` runs once the slot is granted (synchronously
 * if one is free). The returned function must be called exactly once — when
 * the image settles (loads/errors) or when the caller goes away — and
 * releases or revokes the slot.
 */
export const acquireSharpThumbnailSlot = (start: () => void): (() => void) => {
  let state: "waiting" | "active" | "done" = "waiting";
  const waiter: Waiter = {
    revoked: false,
    start: () => {
      state = "active";
      start();
    },
  };

  if (activeLoads < MAX_CONCURRENT_LOADS) {
    activeLoads += 1;
    waiter.start();
  } else {
    waiting.push(waiter);
  }

  return () => {
    if (state === "done") return;
    if (state === "active") {
      activeLoads = Math.max(0, activeLoads - 1);
      state = "done";
      pump();
      return;
    }
    // Still queued: revoke so the slot is never spent on a tile that has
    // already scrolled out of the close band, or been reused for another photo.
    waiter.revoked = true;
    state = "done";
  };
};

/** Test seam: drops any pending state between cases. */
export const resetSharpThumbnailQueue = () => {
  activeLoads = 0;
  waiting.length = 0;
};

export const sharpThumbnailQueueStats = () => ({
  activeLoads,
  waitingCount: waiting.filter((waiter) => !waiter.revoked).length,
});
