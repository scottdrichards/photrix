/**
 * One-shot hand-off between the grid and the fullscreen viewer.
 *
 * Clicking a tile's live badge should open that photo *as its motion clip*, not
 * as a still. Selection only carries a PhotoItem, so the intent is parked here
 * for the viewer to pick up when it mounts for that path. It is consumed on
 * read: reopening the same photo normally afterwards shows the still.
 */
let pendingPath: string | null = null;

export const requestLiveOpen = (path: string): void => {
  pendingPath = path;
};

/** Returns true (once) if this path was opened via its live badge. */
export const consumeLiveOpenIntent = (path: string | null | undefined): boolean => {
  if (!path || pendingPath !== path) return false;
  pendingPath = null;
  return true;
};

export const clearLiveOpenIntent = (): void => {
  pendingPath = null;
};
