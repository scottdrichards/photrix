import {
  FACE_ATTRIBUTE_KEYS,
  type FaceAttributeKey,
} from "../../../shared/filter-contract/src/index.ts";
import type { FaceAttributes } from "./faceDetector.type.ts";

export { FACE_ATTRIBUTE_KEYS, type FaceAttributeKey };

/**
 * Version of the per-face attribute derivation (`server/python/face_attributes.py`).
 *
 * Stored on every scored face row as `faceAttrVersion`, which doubles as the
 * backfill queue: NULL means "never scored". Changing the derivation in a way
 * that should invalidate existing scores means bumping this *and*
 * `FACE_ATTRIBUTE_RESET_VERSION` in indexDatabase.ts — the latter drives a
 * one-time reset of the older rows back to NULL so the background task
 * re-derives them incrementally.
 */
export const FACE_ATTRIBUTE_VERSION = 1;

/**
 * Score column and minimum value for each attribute.
 *
 * The thresholds live server-side rather than being sent by the client so the
 * predicate is always a comparison against a constant — which is what keeps the
 * face filter a covered index probe. They were calibrated by scoring a sample of
 * this library and checking the calls by eye; see face_attributes.py for the
 * measured distributions behind each number.
 */
export const FACE_ATTRIBUTE_PREDICATES: Record<
  FaceAttributeKey,
  { column: string; minimum: number }
> = {
  smiling: { column: "smileScore", minimum: 0.5 },
  eyesOpen: { column: "eyesOpenScore", minimum: 0.5 },
  inFocus: { column: "focusScore", minimum: 0.5 },
  wellExposed: { column: "exposureScore", minimum: 0.4 },
};

export const isFaceAttributeKey = (value: unknown): value is FaceAttributeKey =>
  typeof value === "string" &&
  (FACE_ATTRIBUTE_KEYS as readonly string[]).includes(value);

/**
 * SQL fragments constraining a `faces` row to the requested attributes.
 *
 * `includeUnknown` decides what an unscored face means. It defaults to true:
 * a face the pipeline has not reached yet, or one it could not judge, is
 * *unknown*, not "not smiling", and silently dropping those would quietly hide
 * most of the library while the backfill runs. Callers opt in to the stricter
 * reading, and the UI says which one is active.
 *
 * Every fragment references only columns carried by the `by_file_v4` index, so
 * adding them to the face EXISTS keeps it an index-only probe.
 */
export const faceAttributeConditions = (
  attributes: readonly FaceAttributeKey[],
  { includeUnknown = true }: { includeUnknown?: boolean } = {},
): { conditions: string[]; params: number[] } => {
  const conditions: string[] = [];
  const params: number[] = [];

  // Iterate the canonical key order, not the caller's, so the generated SQL for
  // a given set of attributes is stable and cacheable.
  for (const key of FACE_ATTRIBUTE_KEYS) {
    if (!attributes.includes(key)) continue;
    const { column, minimum } = FACE_ATTRIBUTE_PREDICATES[key];
    conditions.push(
      includeUnknown
        ? `(faces.${column} IS NULL OR faces.${column} >= ?)`
        : `faces.${column} >= ?`,
    );
    params.push(minimum);
  }

  return { conditions, params };
};

/** Clamps a worker-reported attribute to 0..1, mapping anything unusable to null. */
const toScore = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
};

/** Normalises the worker's raw attribute payload for storage. */
export const parseFaceAttributes = (raw: unknown): FaceAttributes => {
  if (!raw || typeof raw !== "object") return {};
  const source = raw as Record<string, unknown>;
  const parsed: FaceAttributes = {};
  const smile = toScore(source.smile);
  if (smile !== null) parsed.smile = smile;
  const eyesOpen = toScore(source.eyesOpen);
  if (eyesOpen !== null) parsed.eyesOpen = eyesOpen;
  const focus = toScore(source.focus);
  if (focus !== null) parsed.focus = focus;
  const exposure = toScore(source.exposure);
  if (exposure !== null) parsed.exposure = exposure;
  return parsed;
};
