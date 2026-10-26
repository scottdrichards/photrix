import type { FaceAppearance, PhotoPersonFace } from "../api/types";

export type VideoPerson = {
  personId: string;
  name: string | null;
  /** Earliest first, overlapping stretches merged. */
  appearances: FaceAppearance[];
  first: FaceAppearance;
  longest: FaceAppearance;
  totalMs: number;
};

const merge = (spans: FaceAppearance[]): FaceAppearance[] => {
  const sorted = [...spans].sort((a, b) => a.startMs - b.startMs);
  const merged: FaceAppearance[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.startMs <= last.endMs) last.endMs = Math.max(last.endMs, span.endMs);
    else merged.push({ ...span });
  }
  return merged;
};

/**
 * Who is on screen in a video and when, one entry per person, in the order
 * they first appear. Several faces can belong to one person (the video pass
 * split them, or they were merged later), so their stretches are pooled.
 */
export const videoPeople = (faces: readonly PhotoPersonFace[]): VideoPerson[] => {
  const byPerson = new Map<string, { name: string | null; spans: FaceAppearance[] }>();
  for (const face of faces) {
    const spans =
      face.appearances ??
      (face.frameTimeMs != null
        ? [{ startMs: face.frameTimeMs, endMs: face.frameTimeMs }]
        : []);
    if (spans.length === 0) continue;
    const entry = byPerson.get(face.personId) ?? { name: face.name, spans: [] };
    entry.name ??= face.name;
    entry.spans.push(...spans);
    byPerson.set(face.personId, entry);
  }
  return [...byPerson.entries()]
    .map(([personId, { name, spans }]) => {
      const appearances = merge(spans);
      const longest = appearances.reduce((best, span) =>
        span.endMs - span.startMs > best.endMs - best.startMs ? span : best,
      );
      return {
        personId,
        name,
        appearances,
        first: appearances[0],
        longest,
        totalMs: appearances.reduce((sum, s) => sum + (s.endMs - s.startMs), 0),
      };
    })
    .sort((a, b) => a.first.startMs - b.first.startMs);
};

/** "0:07", "1:02:05". */
export const formatClock = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
};
