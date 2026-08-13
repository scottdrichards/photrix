/**
 * Turning one Frigate event into the frames worth looking for a face in.
 *
 * This lives here rather than in the caller's automation because deriving it
 * needs the event's movement track, and getting that wrong is silent: a
 * template that reads the wrong field just renders nothing and the lookup
 * quietly never happens.
 *
 * Consumes the **REST** `/api/events/<id>` record. Frigate publishes the same
 * event in two incompatible shapes, and they disagree about more than nesting:
 *
 * | | REST record | MQTT `frigate/events` |
 * |---|---|---|
 * | location | `data.box` | `box` (top level) |
 * | meaning | normalized `[x, y, w, h]` | **pixel** `[x1, y1, x2, y2]` |
 * | zones | `zones` | `current_zones` / `entered_zones` |
 *
 * Converting the MQTT form needs the detect-stream dimensions, which are not in
 * the payload — so rather than guess, a box that isn't normalized is refused
 * outright (see `asNormalizedBox`). The caller passes only the event **id**,
 * which is the one field identical in both, and this code fetches the record it
 * actually understands.
 */

/** Normalized [x, y, width, height]. */
export type NormalizedBox = [number, number, number, number];

export type FrigateFrame = {
  url: string;
  box: NormalizedBox;
  pad: number;
};

/** The subset of a Frigate event record this needs, in either shape. */
export type FrigateEventRecord = {
  camera?: unknown;
  start_time?: unknown;
  end_time?: unknown;
  box?: unknown;
  path_data?: unknown;
  data?: { box?: unknown; path_data?: unknown } | null;
};

export type DeriveOptions = {
  /** `host:port` of the Frigate instance, used to build the frame URLs. */
  host: string;
  /** Maximum frames to derive. */
  maxFrames?: number;
  /** Padding around each box, as a fraction of the box. */
  pad?: number;
};

export const DEFAULT_FRIGATE_FRAMES = 4;

/**
 * Padding around the person box.
 *
 * Wider than the crop default because these boxes come from a *track*: the box
 * dimensions are sampled at the event's best-scoring moment but applied at
 * other moments, when the subject may be nearer, further, or mid-stride.
 */
export const DEFAULT_FRIGATE_PAD = 0.6;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * A box we can actually crop with: four finite numbers, all within 0..1.
 *
 * The range check is the guard against being handed MQTT's pixel-corner box by
 * mistake. Treating `[528, 244, 566, 262]` as normalized would crop far outside
 * the frame and silently find nothing — the exact failure mode this module
 * exists to prevent, so it refuses instead.
 */
const asNormalizedBox = (value: unknown): NormalizedBox | null => {
  if (!Array.isArray(value) || value.length !== 4) return null;
  if (!value.every(isFiniteNumber)) return null;
  if (!value.every((n: number) => n >= 0 && n <= 1)) return null;
  const [x, y, width, height] = value;
  // A zero-area box gives an empty crop; nothing to look at.
  if (width <= 0 || height <= 0) return null;
  return [x, y, width, height];
};

/** One `[[cx, cy], timestamp]` entry of Frigate's `path_data`. */
type PathPoint = { cx: number; cy: number; at: number };

const asPathData = (value: unknown): PathPoint[] => {
  if (!Array.isArray(value)) return [];
  const points: PathPoint[] = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const centroid: unknown = entry[0];
    const at: unknown = entry[1];
    if (!Array.isArray(centroid) || centroid.length < 2) continue;
    if (!isFiniteNumber(centroid[0]) || !isFiniteNumber(centroid[1])) continue;
    if (!isFiniteNumber(at)) continue;
    points.push({ cx: centroid[0], cy: centroid[1], at });
  }
  return points;
};

/** Picks `count` evenly-spaced items, always including the first and last. */
const evenlySpaced = <T>(items: T[], count: number): T[] => {
  if (items.length === 0 || count <= 0) return [];
  const take = Math.min(count, items.length);
  if (take === 1) return [items[0]];
  return Array.from(
    { length: take },
    (_, i) => items[Math.round(((items.length - 1) * i) / (take - 1))],
  );
};

/**
 * Frames to inspect for one event, newest-usable-evidence first.
 *
 * Prefers the movement track: each sampled moment gets a box centred on where
 * the subject actually was *then*, because a walking visitor is somewhere
 * different in every frame and a single box would crop most of them onto empty
 * driveway. Falls back to the event's own box held constant across evenly
 * spaced timestamps when no track is present (a stationary subject, or a
 * Frigate version that doesn't record one).
 *
 * Returns [] when the record carries neither a box nor a track — there is
 * nothing to crop to, and cropping is what makes a distant face detectable.
 */
export const deriveFrigateFrames = (
  event: FrigateEventRecord,
  { host, maxFrames = DEFAULT_FRIGATE_FRAMES, pad = DEFAULT_FRIGATE_PAD }: DeriveOptions,
): FrigateFrame[] => {
  const camera = typeof event.camera === "string" ? event.camera : null;
  if (!camera) return [];

  // `data.*` is the REST record. The top-level fallbacks exist only so a record
  // from a future/older Frigate that flattens them still works — and
  // asNormalizedBox rejects the box if it turns out to be MQTT's pixel form.
  const box = asNormalizedBox(event.data?.box ?? event.box);
  const path = asPathData(event.data?.path_data ?? event.path_data);
  if (!box) return [];
  const [, , boxWidth, boxHeight] = box;

  const snapshotUrl = (at: number): string =>
    `http://${host}/api/${camera}/recordings/${Math.floor(at)}/snapshot.jpg`;

  if (path.length > 0) {
    return evenlySpaced(path, maxFrames).map((point) => ({
      url: snapshotUrl(point.at),
      // path_data gives the object's centre; the stored box gives its size.
      box: [
        point.cx - boxWidth / 2,
        point.cy - boxHeight / 2,
        boxWidth,
        boxHeight,
      ] as NormalizedBox,
      pad,
    }));
  }

  const start = isFiniteNumber(event.start_time) ? event.start_time : null;
  if (start === null) return [];
  // An event that has not ended yet has no end_time; sample the seconds either
  // side of its start rather than refusing to look at all.
  const end = isFiniteNumber(event.end_time) ? event.end_time : start + 10;
  const span = Math.max(0, end - start);
  const count = Math.max(1, maxFrames);
  return Array.from({ length: count }, (_, i) => ({
    // Interior points only: the very first and last moment of an event are the
    // subject entering and leaving frame, usually half-occluded.
    url: snapshotUrl(start + (span * (i + 1)) / (count + 1)),
    box,
    pad,
  }));
};
