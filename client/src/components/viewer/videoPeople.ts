import type { FaceAppearance, PhotoPersonFace } from "../../api/types";

type VideoPerson = {
  personId: string;
  name: string | null;
  /** Earliest first, overlapping stretches merged. */
  appearances: FaceAppearance[];
  first: FaceAppearance;
  longest: FaceAppearance;
  totalMs: number;
  /**
   * Set only on the pooled row from `videoTimelineRows`: how many unnamed
   * people it stands for.
   */
  pooledCount?: number;
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

/** The pooled row's id; real person ids are numeric cluster ids. */
export const UNNAMED_ROW_ID = "unnamed";

const longestOf = (appearances: FaceAppearance[]): FaceAppearance =>
  appearances.reduce((best, span) =>
    span.endMs - span.startMs > best.endMs - best.startMs ? span : best,
  );

/**
 * The rows the viewer's people strip shows: every named person in the order
 * they first appear, then everyone unnamed pooled into one last row.
 *
 * Feedback #159: a busy video (a class performance) had 39 people, 35 of them
 * unnamed. One row per unnamed person filled the strip with identical
 * "Unnamed" labels and pushed it into a scrollbar. Told apart only by their
 * bars, separate unnamed rows don't help anyone find someone, so they share one.
 */
export const videoTimelineRows = (faces: readonly PhotoPersonFace[]): VideoPerson[] => {
  const people = videoPeople(faces);
  const named = people.filter((person) => person.name);
  const unnamed = people.filter((person) => !person.name);
  if (unnamed.length <= 1) return [...named, ...unnamed];
  const appearances = merge(unnamed.flatMap((person) => person.appearances));
  return [
    ...named,
    {
      personId: UNNAMED_ROW_ID,
      name: null,
      appearances,
      first: appearances[0],
      longest: longestOf(appearances),
      totalMs: appearances.reduce((sum, span) => sum + (span.endMs - span.startMs), 0),
      pooledCount: unnamed.length,
    },
  ];
};

/** "0:07", "1:02:05". */
export const formatClock = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
};
