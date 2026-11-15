/**
 * The optics behind the wordmark's focus effect.
 *
 * The scene is a camera 20 m from the wordmark, with clouds 200 m away behind
 * it. A lens focused at distance d blurs an object at distance s in proportion
 * to |1/d - 1/s|, the defocus in dioptres, and the focusing element travels in
 * dioptres too. So the focus pull is interpolated in dioptres and every blur
 * is computed from it. The word and the clouds can never disagree about where
 * focus is, and the clouds, 180 m further back, are never sharp.
 *
 * A consequence worth knowing before retuning: once the lens is near 20 m, the
 * 25 m overshoot and the 18 m correction defocus the word by under 0.3 px, as
 * they would in a real camera at this distance. The visible part of the hunt is
 * the rack in from 3 m.
 */

export const SUBJECT_M = 20;
export const CLOUDS_M = 200;
export const START_M = 3;

/** On-screen blur per dioptre of defocus: the lens's aperture, in effect. */
export const BLUR_PX_PER_DIOPTRE = 25;
/** Clouds have soft edges even when in focus. */
const CLOUD_SOFTNESS_PX = 1.5;
/** Focus breathing: the image grows slightly as the lens racks closer. */
const BREATHING_PER_DIOPTRE = 0.04;
/** Keyframes are sampled at this interval; the browser interpolates between them. */
const FRAME_MS = 1000 / 30;

export const SHEEN_MS = 1600;
export const SHEEN_EASING = "cubic-bezier(0.45, 0, 0.25, 1)";
const CLOUD_FADE_MS = 600;
const INTRO_HOLD_MS = 400;

type Ease = (p: number) => number;
const easeInOut: Ease = (p) => (p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2);
const easeOut: Ease = (p) => 1 - (1 - p) ** 3;
const still: Ease = () => 0;

type Move = { toM: number; ms: number; ease: Ease } | { holdMs: number };

/**
 * The pull, after the lens starts at 3 m: a fast rack out past the word to
 * 25 m, a pause, a correction back to 18 m, another pause, then a slow settle
 * on 20 m.
 */
export const FOCUS_PULL: readonly Move[] = [
  { toM: 25, ms: 900, ease: easeInOut },
  { holdMs: 120 },
  { toM: 18, ms: 450, ease: easeInOut },
  { holdMs: 110 },
  { toM: 20, ms: 380, ease: easeOut },
];

export type FocusPlay = "intro" | "replay";

type Segment = { fromD: number; toD: number; ms: number; ease: Ease };

/**
 * On load the lens is already at 3 m and holds there before pulling. A replay
 * starts from a sharp word, so it first racks out from 20 m to 3 m.
 */
const segments = (play: FocusPlay): Segment[] => {
  const lead: Move =
    play === "intro"
      ? { holdMs: INTRO_HOLD_MS }
      : { toM: START_M, ms: 450, ease: easeInOut };
  let at = 1 / (play === "intro" ? START_M : SUBJECT_M);
  return [lead, ...FOCUS_PULL].map((move) => {
    if ("holdMs" in move) return { fromD: at, toD: at, ms: move.holdMs, ease: still };
    const from = at;
    at = 1 / move.toM;
    return { fromD: from, toD: at, ms: move.ms, ease: move.ease };
  });
};

/** How long the focus pull takes, which is also when the colour sweep starts. */
export const focusMs = (play: FocusPlay) =>
  segments(play).reduce((sum, s) => sum + s.ms, 0);

/** From the start of a play to the end of the colour sweep. */
export const playMs = (play: FocusPlay) => focusMs(play) + SHEEN_MS;

/** Where the lens is, in dioptres (1 / focus distance in metres), at a time into a play. */
export const lensDioptresAt = (play: FocusPlay, ms: number) => {
  let t = ms;
  const all = segments(play);
  for (const s of all) {
    if (t <= s.ms) return s.fromD + (s.toD - s.fromD) * s.ease(s.ms === 0 ? 1 : t / s.ms);
    t -= s.ms;
  }
  return all[all.length - 1].toD;
};

/** Optical blur of an object at objectM when the lens is at lensD dioptres. */
export const blurPx = (lensD: number, objectM: number) =>
  BLUR_PX_PER_DIOPTRE * Math.abs(lensD - 1 / objectM);

const round = (v: number) => Math.round(v * 100) / 100;

/**
 * Web Animations keyframes for one play: the word (P included) and the clouds
 * share a timeline. The clouds fade in on a replay's rack out and fade away
 * once the word is in focus. Durations are the same for both, so one timing
 * object drives both.
 */
export const focusKeyframes = (play: FocusPlay) => {
  const focusEnd = focusMs(play);
  const durationMs = focusEnd + CLOUD_FADE_MS;
  const lead = segments(play)[0].ms;
  const times = new Set<number>([0, durationMs]);
  for (let t = 0; t < durationMs; t += FRAME_MS) times.add(round(t));
  segments(play).reduce((at, s) => (times.add(at + s.ms), at + s.ms), 0);

  const word: Keyframe[] = [];
  const clouds: Keyframe[] = [];
  for (const t of [...times].sort((a, b) => a - b)) {
    const lens = lensDioptresAt(play, t);
    const offset = round((t / durationMs) * 10000) / 10000;
    const scale = `scale(${round((1 + BREATHING_PER_DIOPTRE * (lens - 1 / SUBJECT_M)) * 100) / 100})`;
    const fadeIn = play === "replay" ? Math.min(1, t / lead) : 1;
    const fadeOut = t <= focusEnd ? 1 : 1 - (t - focusEnd) / CLOUD_FADE_MS;
    word.push({
      offset,
      filter: `blur(${round(blurPx(lens, SUBJECT_M))}px)`,
      transform: scale,
    });
    clouds.push({
      offset,
      filter: `blur(${round(blurPx(lens, CLOUDS_M) + CLOUD_SOFTNESS_PX)}px)`,
      transform: scale,
      opacity: round(Math.min(fadeIn, fadeOut)),
    });
  }
  return { word, clouds, durationMs };
};
