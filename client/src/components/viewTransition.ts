import { flushSync } from "react-dom";

/**
 * Stable per-photo identity for the View Transitions API — lets the browser
 * match a photo's element across a DOM change (a grid tile becoming the
 * fullscreen viewer's media, a stack's representative becoming one of its
 * unstacked members, or the reverse of either) and animate it
 * expanding/collapsing into place instead of just cutting over. Not
 * guaranteed globally unique across pathologically-similar paths (two
 * different real characters both collapsing to the same `-`), but a
 * collision is only possible between elements that would be visible
 * *simultaneously* in the same transition — negligible for real photo
 * filenames.
 */
export const photoViewTransitionName = (path: string): string =>
  `photrix-tile-${path.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

/**
 * Feature-detects the View Transitions API and runs `update` through it when
 * available, falling back to a plain (unanimated) update otherwise. Safari
 * added support in 18.2 (late 2024); older Safari/Firefox silently get the
 * plain path with no error.
 */
export const runWithViewTransition = (update: () => void): void => {
  const startViewTransition = document.startViewTransition?.bind(document);
  if (!startViewTransition) {
    update();
    return;
  }
  startViewTransition(() => flushSync(update));
};
