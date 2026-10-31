/**
 * Tells a tile whether a `mouseenter` it just received represents the user
 * actually pointing at it, or is only fallout from the page scrolling underneath
 * a stationary cursor.
 *
 * Why this exists: on Windows people scroll with the wheel, which leaves the
 * cursor parked over the grid. After every scroll the browser re-runs hit
 * testing and fires mouseenter/mouseleave on each tile that slid under the
 * pointer — twenty-odd tiles a second during a brisk scroll. Each of those
 * "hovers" used to re-render the tile, mount a drop-shadowed checkbox overlay,
 * start a non-composited hover transition, and kick off a full-resolution
 * thumbnail fetch for a photo the user was merely scrolling past. That is the
 * jerkiness, and it is our doing rather than the browser's.
 *
 * The rule: for a short window after any scroll, hover is ignored. Real pointer
 * movement cancels the window immediately, so deliberately moving onto a tile is
 * never delayed. Movement is judged by comparing coordinates, because the
 * synthetic pointer events browsers dispatch to refresh hover state after a
 * scroll carry the previous position.
 */

const SUPPRESSION_MS = 180;

let suppressedUntil = 0;
let lastX = Number.NaN;
let lastY = Number.NaN;
let listenersAttached = false;

const now = (): number => Date.now();

const handleScroll = (): void => {
  suppressedUntil = now() + SUPPRESSION_MS;
};

const handlePointerMove = (event: PointerEvent): void => {
  // A scroll-triggered hover refresh reports the position the pointer already
  // had; only a genuine move clears the suppression window.
  if (event.clientX === lastX && event.clientY === lastY) return;
  lastX = event.clientX;
  lastY = event.clientY;
  suppressedUntil = 0;
};

const ensureListeners = (): void => {
  if (listenersAttached || typeof window === "undefined") return;
  listenersAttached = true;
  // Capture phase so scrolling inside any nested scroller counts; passive so
  // neither listener can ever delay a scroll frame.
  window.addEventListener("scroll", handleScroll, { capture: true, passive: true });
  window.addEventListener("pointermove", handlePointerMove, { passive: true });
  window.addEventListener("pointerdown", handlePointerMove, { passive: true });
};

// Attached on import rather than on first hover: the listeners have to already
// be in place when the *first* scroll happens, otherwise that scroll's hover
// storm is the one that gets through.
ensureListeners();

/** True when a mouseenter right now is scroll fallout and should be ignored. */
export const isHoverSuppressedByScroll = (): boolean => now() < suppressedUntil;

export const __resetHoverIntentForTests = (): void => {
  suppressedUntil = 0;
  lastX = Number.NaN;
  lastY = Number.NaN;
};
