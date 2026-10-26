import type { DetectedFace } from "../faceDetection/faceDetector.type.ts";

/**
 * Reduces the faces found across a video's sampled frames to one face per
 * person.
 *
 * Someone on screen for twenty seconds turns up in most sampled frames.
 * Storing every one would put a single video into a person's People grid a
 * dozen times over and weight the cluster centroid toward that one clip. So
 * faces are grouped into tracks, and each track keeps only its most
 * recognisable face: the one a human would pick as the crop, and the one whose
 * embedding is most trustworthy.
 *
 * Grouping is greedy, best faces first. A face joins the first track holding a
 * face it resembles at {@link VIDEO_TRACK_SIMILARITY} or more. Two faces from
 * the same frame never share a track, since they are two different people
 * standing side by side.
 *
 * Each kept face also carries when that person is on screen, from the frames
 * its track was seen in (see {@link trackAppearances}). It costs nothing extra:
 * the track already knows its frames.
 */

/**
 * Lower than the cluster threshold (0.62, faceClusterEngine.ts) on purpose:
 * one clip has one light and one camera, so the same person scores higher
 * there than across years of photos. Measured 2026-10-26 on 6,000 faces of 57
 * named people in the library: different people reach 0.45 in 0.03% of pairs
 * (0.4: 0.09%, 0.5: 0.01%). On 14 real videos, 0.5 left the same person split
 * into two or three tracks at 0.44-0.50, which 0.45 mostly joins. Two faces in
 * one frame are kept apart regardless, which covers people side by side.
 */
export const VIDEO_TRACK_SIMILARITY = 0.45;

/**
 * Faces narrower than this share of the frame are dropped. In real videos
 * these are the crowd in the background, 20-60 px across: on 14 videos none
 * of them matched a named person with any margin, and every confident match
 * was wider. Each would otherwise become a "person" of its own.
 */
export const MIN_VIDEO_FACE_WIDTH = 0.035;

/**
 * Two stretches of one person closer than this are one appearance. It bridges a
 * single keyframe where the detector missed them (a turned head, motion blur);
 * keyframes are about a second apart, seeks on a long video far more, so a real
 * exit and re-entry is never merged on a long video's coarse grid.
 */
export const APPEARANCE_MERGE_GAP_MS = 2_000;

/** One frame's faces, and the stretch of video the frame stands for. */
export type FrameFaces = {
  timeMs: number;
  startMs: number;
  endMs: number;
  faces: DetectedFace[];
};

/** A stretch of video, in ms from the start, that a person is on screen for. */
export type FaceAppearance = { startMs: number; endMs: number };

export type VideoFace = DetectedFace & {
  frameTimeMs: number;
  /** When this person is on screen, earliest first. Never empty. */
  appearances: FaceAppearance[];
};

const cosine = (a: Float64Array, b: Float64Array): number => {
  if (a.length === 0 || a.length !== b.length) return -1;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : -1;
};

/**
 * Bigger, more confident, sharper faces are easier to recognise. Area enters
 * as its square root (the face's width), so a large face wins without a huge
 * one swamping a sharp one. Focus is unknown for some faces; unknown counts as
 * middling, never as blurry.
 */
export const faceQuality = (face: DetectedFace): number => {
  const size = Math.sqrt(Math.max(0, face.box.width * face.box.height));
  const focus = face.attributes?.focus ?? 0.5;
  return face.confidence * size * (0.5 + 0.5 * focus);
};

export const collapseFaceTracks = (
  frames: readonly FrameFaces[],
  threshold = VIDEO_TRACK_SIMILARITY,
): VideoFace[] => {
  const candidates = frames
    .flatMap((frame, frameIndex) =>
      frame.faces.map((face) => ({
        face: { ...face, frameTimeMs: frame.timeMs },
        frameIndex,
        quality: faceQuality(face),
      })),
    )
    .sort((a, b) => b.quality - a.quality);

  type Track = {
    best: DetectedFace & { frameTimeMs: number };
    members: typeof candidates;
    frames: Set<number>;
  };
  const tracks: Track[] = [];

  for (const candidate of candidates) {
    // A face with no embedding can't be matched; it never joins a track, and
    // can't be clustered either, so it isn't worth storing.
    if (candidate.face.embedding.length === 0) continue;
    if (candidate.face.box.width < MIN_VIDEO_FACE_WIDTH) continue;
    const track = tracks.find(
      (t) =>
        !t.frames.has(candidate.frameIndex) &&
        t.members.some(
          (m) => cosine(m.face.embedding, candidate.face.embedding) >= threshold,
        ),
    );
    if (track) {
      track.members.push(candidate);
      track.frames.add(candidate.frameIndex);
    } else {
      // Candidates arrive best-first, so the face that opens a track is its best.
      tracks.push({
        best: candidate.face,
        members: [candidate],
        frames: new Set([candidate.frameIndex]),
      });
    }
  }

  const ordered = tracks.map((t) => ({
    ...t.best,
    appearances: trackAppearances(frames, t.frames),
  }));
  // Earliest appearance first: the order a viewer would meet them in.
  return ordered.sort(
    (a, b) =>
      a.appearances[0].startMs - b.appearances[0].startMs ||
      a.frameTimeMs - b.frameTimeMs,
  );
};

/**
 * The stretches a track is on screen, from the frames it was seen in. A run of
 * consecutive analysed frames covers the first one's start to the last one's
 * end, including any frames thinned out between them: someone seen in two
 * frames in a row was there in between too. Only a frame that was analysed and
 * did *not* show them ends a run.
 */
export const trackAppearances = (
  frames: readonly FrameFaces[],
  seenIn: ReadonlySet<number>,
): FaceAppearance[] => {
  const runs: FaceAppearance[] = [];
  let open: FaceAppearance | null = null;
  frames.forEach((frame, index) => {
    if (seenIn.has(index)) {
      if (open) open.endMs = Math.max(open.endMs, frame.endMs);
      else open = { startMs: frame.startMs, endMs: frame.endMs };
      return;
    }
    if (open) runs.push(open);
    open = null;
  });
  if (open) runs.push(open);

  const merged: FaceAppearance[] = [];
  for (const run of runs) {
    const last = merged.at(-1);
    if (last && run.startMs - last.endMs <= APPEARANCE_MERGE_GAP_MS) {
      last.endMs = Math.max(last.endMs, run.endMs);
    } else {
      merged.push({ ...run });
    }
  }
  return merged;
};
