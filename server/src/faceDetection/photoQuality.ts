import type { FaceAttributes } from "./faceDetector.type.ts";

/**
 * The four already-stored per-face columns (see tables.ts's `faces` table and
 * faceAttributes.ts) that feed the whole-photo aggregate below. Any of them
 * may be `null` — "unknown", never "failing".
 */
export type FaceQualityInputs = {
  smileScore: number | null;
  eyesOpenScore: number | null;
  focusScore: number | null;
  exposureScore: number | null;
};

/**
 * Aggregates the per-face "photo ready" attributes (smiling / eyes open / in
 * focus / well exposed — see faceAttributes.ts and python/face_attributes.py)
 * into a single 0..1 whole-photo quality score.
 *
 * This is deliberately a two-level aggregation, and the two levels combine
 * their scores differently:
 *
 *  1. *Within* a face: average the attributes that were actually judged.
 *     Averaging (rather than taking that face's worst attribute) is the
 *     right read here — a face that scores low on "smiling" but is sharp,
 *     well exposed and eyes-open is a perfectly fine photo of a neutral
 *     expression, not a bad one. One weak attribute should pull a face's
 *     score down, not veto it outright.
 *
 *  2. *Across* faces: take the minimum of the per-face scores, not the
 *     average. A photo's usefulness is set by its worst face, not diluted by
 *     its best one. A ten-person group photo where one person blinked or
 *     moved is exactly the kind of "genuinely bad shot" a user browsing
 *     wants surfaced — averaging across a large group would hide that one
 *     ruined face inside an otherwise-good group score, which is the
 *     opposite of useful here.
 *
 * A face with every attribute unknown (never scored, or every measure came
 * back "can't tell" — e.g. a profile view, a too-small crop) is excluded
 * entirely rather than counted as a 0 or a 1: it carries no information
 * either way. A photo where every detected face is like that — or one with
 * no detected faces at all — returns `null`, meaning "no quality signal",
 * which callers must not read as "low quality".
 *
 * Photos with no faces intentionally get no score here. Folding in a
 * whole-frame sharpness/exposure measure for facesless photos was considered
 * and deliberately scoped out: no such signal exists anywhere else in this
 * codebase to reuse (only the per-face crop statistics in
 * python/face_attributes.py exist), and calibrating a new one — distinguishing
 * "blurry" from "smooth/plain" at whole-image scale, picking thresholds with
 * no library sample to validate them against, the way the existing per-face
 * constants were calibrated — is a materially bigger undertaking than this
 * feature warrants. See the project status notes (`status_19.md`) for the
 * fuller reasoning.
 */
export const computePhotoQualityScore = (
  faces: readonly FaceQualityInputs[],
): number | null => {
  const perFaceScores: number[] = [];

  for (const face of faces) {
    const available = [
      face.smileScore,
      face.eyesOpenScore,
      face.focusScore,
      face.exposureScore,
    ].filter(
      (score): score is number => typeof score === "number" && Number.isFinite(score),
    );

    if (available.length === 0) continue;

    const average = available.reduce((sum, score) => sum + score, 0) / available.length;
    perFaceScores.push(average);
  }

  if (perFaceScores.length === 0) return null;
  return Math.min(...perFaceScores);
};

/**
 * Adapts a freshly-detected face's in-memory `FaceAttributes` (the shape used
 * by `saveFaceDetectionResult` before anything is written to the `faces`
 * table) to the column-shaped input `computePhotoQualityScore` expects. Kept
 * separate from the stored-row shape so callers reading back from SQL can
 * pass rows straight through without an extra mapping step.
 */
export const faceAttributesToQualityInputs = (
  attributes: FaceAttributes | undefined,
): FaceQualityInputs => ({
  smileScore: attributes?.smile ?? null,
  eyesOpenScore: attributes?.eyesOpen ?? null,
  focusScore: attributes?.focus ?? null,
  exposureScore: attributes?.exposure ?? null,
});
