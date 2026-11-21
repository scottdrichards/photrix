import type { StoryFace, StoryItem } from "./storyTypes.ts";

export type HighlightCandidate = {
  item: StoryItem;
  faces: StoryFace[];
  /** Unit-length CLIP image embedding, when the photo has one. */
  embedding: Float32Array | null;
};

/**
 * How much a photo wants to be in the recap, before diversity: stars, the
 * face-quality score, named people, and a nudge toward landscape frames,
 * which fill a screen.
 */
export const highlightScore = ({ item, faces }: HighlightCandidate) =>
  1 +
  ((item.rating ?? 0) / 5) * 0.8 +
  (item.quality ?? 0.5) * 0.6 +
  Math.min(3, faces.filter(({ name }) => name).length) * 0.25 +
  (faces.length ? 0.15 : 0) +
  ((item.width ?? 0) > (item.height ?? 0) ? 0.1 : 0);

/** How many frames a story of `count` showable photos gets: grows with the square root, 6 to 40. */
export const frameCount = (count: number) =>
  Math.min(count, Math.max(6, Math.min(40, Math.round(6 + 2.5 * Math.sqrt(count)))));

const cosine = (a: Float32Array, b: Float32Array) => {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
};

/**
 * Picks `count` highlights by greedy maximal marginal relevance: each pick is
 * the best-scoring photo after penalties for looking like one already picked
 * (CLIP cosine above 0.75 ramps to a full penalty at 1) and for crowding the
 * same stretch of time. Returned in time order.
 */
export const pickHighlights = (
  candidates: HighlightCandidate[],
  count: number,
): HighlightCandidate[] => {
  if (candidates.length <= count)
    return [...candidates].sort((a, b) => a.item.time - b.item.time);
  const times = candidates.map(({ item }) => item.time);
  const spread = Math.max(60_000, (Math.max(...times) - Math.min(...times)) / count);
  const scores = candidates.map(highlightScore);
  // Each candidate's worst likeness and crowding against the picks so far,
  // updated against only the newest pick: O(count x candidates) cosines.
  const likeness = new Float64Array(candidates.length);
  const crowding = new Float64Array(candidates.length);
  const picked: number[] = [];
  const remaining = new Set(candidates.keys());
  while (picked.length < count) {
    let best = -1;
    let bestValue = -Infinity;
    for (const index of remaining) {
      const value =
        scores[index] -
        1.5 * Math.max(0, (likeness[index] - 0.75) / 0.25) -
        0.6 * crowding[index];
      if (value > bestValue) {
        bestValue = value;
        best = index;
      }
    }
    picked.push(best);
    remaining.delete(best);
    const { item: pick, embedding: pickEmbedding } = candidates[best];
    for (const index of remaining) {
      const { item, embedding } = candidates[index];
      if (embedding && pickEmbedding)
        likeness[index] = Math.max(likeness[index], cosine(embedding, pickEmbedding));
      crowding[index] = Math.max(
        crowding[index],
        Math.exp(-Math.abs(item.time - pick.time) / spread),
      );
    }
  }
  return picked
    .map((index) => candidates[index])
    .sort((a, b) => a.item.time - b.item.time);
};
