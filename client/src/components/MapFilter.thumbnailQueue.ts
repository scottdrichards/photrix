/**
 * A tiny FIFO gate for the map's representative thumbnails.
 *
 * The map never asks for more than a capped number of representatives, but on a
 * thin uplink even a dozen simultaneous requests means a dozen half-drawn
 * images. Admitting a few at a time makes the first ones land quickly instead of
 * all of them crawling together, and — because a waiting entry can be revoked —
 * a pin that leaves the viewport before its turn never issues a request at all.
 */

const MAX_CONCURRENT_LOADS = 4;

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
 * Requests a load slot. `start` runs once the slot is granted (synchronously if
 * one is free). The returned function must be called exactly once — when the
 * image settles or when the caller goes away — and releases or revokes the slot.
 */
export const acquireThumbnailSlot = (start: () => void): (() => void) => {
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
    // Still queued: revoke so the slot is never spent on a marker that has
    // already scrolled/panned out of view.
    waiter.revoked = true;
    state = "done";
  };
};

/** Test seam: drops any pending state between cases. */
export const resetThumbnailQueue = () => {
  activeLoads = 0;
  waiting.length = 0;
};

export const thumbnailQueueStats = () => ({
  activeLoads,
  waitingCount: waiting.filter((waiter) => !waiter.revoked).length,
});
