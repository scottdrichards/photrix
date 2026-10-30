/**
 * Screen-space thinning for the fullscreen map's representative photos.
 *
 * The pin feed can hold up to a thousand clusters, and showing a thumbnail for
 * each would both crowd the map and stall on a slow link. Instead this picks a
 * small, well-spread subset in *pixel* space at the current zoom: candidates are
 * ranked (busiest pin first), then accepted greedily only when they sit at least
 * `minSeparationPx` from every pin already accepted, stopping at `cap`. The cost
 * is therefore bounded by the cap, not by the number of pins, and the result
 * cannot visually overlap.
 */

export type PixelCandidate = {
  /** Stable identity across pans so an unchanged marker is not remounted. */
  key: string;
  /** Viewport pixel position at the current view. */
  x: number;
  y: number;
  /** Higher wins the slot; the pin's photo count. */
  weight: number;
};

export type SelectRepresentativesOptions = {
  /** Map viewport size in CSS pixels. */
  width: number;
  height: number;
  /** Hard upper bound on returned representatives. */
  cap?: number;
  /** Minimum pixel distance between two chosen representatives. */
  minSeparationPx?: number;
  /**
   * Pixels of inset required on every edge — a thumbnail bubble whose anchor is
   * closer than this to the edge would hang half off the map.
   */
  edgeInsetPx?: number;
};

export const DEFAULT_REPRESENTATIVE_CAP = 12;
export const DEFAULT_MIN_SEPARATION_PX = 108;
const DEFAULT_EDGE_INSET_PX = 44;

export const selectRepresentatives = <T extends PixelCandidate>(
  candidates: readonly T[],
  {
    width,
    height,
    cap = DEFAULT_REPRESENTATIVE_CAP,
    minSeparationPx = DEFAULT_MIN_SEPARATION_PX,
    edgeInsetPx = DEFAULT_EDGE_INSET_PX,
  }: SelectRepresentativesOptions,
): T[] => {
  if (cap <= 0 || width <= 0 || height <= 0) {
    return [];
  }

  const inView = candidates.filter(
    (candidate) =>
      Number.isFinite(candidate.x) &&
      Number.isFinite(candidate.y) &&
      candidate.x >= edgeInsetPx &&
      candidate.x <= width - edgeInsetPx &&
      candidate.y >= edgeInsetPx &&
      candidate.y <= height - edgeInsetPx,
  );

  // Busiest pin first; key order breaks ties so a redraw at the same view picks
  // the same photos instead of shuffling.
  const ranked = [...inView].sort(
    (a, b) => b.weight - a.weight || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );

  const minSeparationSquared = minSeparationPx * minSeparationPx;
  const chosen: T[] = [];
  for (const candidate of ranked) {
    if (chosen.length >= cap) break;
    const crowded = chosen.some((accepted) => {
      const dx = accepted.x - candidate.x;
      const dy = accepted.y - candidate.y;
      return dx * dx + dy * dy < minSeparationSquared;
    });
    if (!crowded) {
      chosen.push(candidate);
    }
  }
  return chosen;
};
