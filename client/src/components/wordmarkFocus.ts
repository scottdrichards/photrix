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
 * A consequence worth knowing before retuning: near 20 m, focus errors in
 * metres barely show. An overshoot to 25 m defocuses the word by only 0.25 px,
 * so the hunt overshoots hard, to 40 m and back to 13 m, to read as a miss.
 * Overshooting further would bring the lens too near the clouds' focus.
 *
 * The camera is handheld, too. It starts off-aim and drifts onto the word with
 * a small overshoot, while a hand tremor shakes it. Both die away as focus
 * locks. A handheld wobble is mostly rotation, which shifts near and far planes
 * by the same amount, so the word and the clouds move together.
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
const FRAME_MS = 1000 / 60;

/** Camera shake, in em so it scales with the wordmark. */
const SHAKE_EM = 0.08;
/** Where the camera is pointing when it starts, as a multiple of SHAKE_EM. */
const AIM_START = { x: -1.3, y: 0.8 };
/** The drift onto the word: a damped swing, with this time constant and rate. */
const AIM_SETTLE_MS = 200;
const AIM_SWING_HZ = 2;
type Wave = readonly [hz: number, phase: number, weight: number];
/** Hand tremor: a few incommensurate sines, slow sway plus a faster jitter. */
const TREMOR: { x: readonly Wave[]; y: readonly Wave[] } = {
  x: [
    [1.7, 0.4, 0.55],
    [3.1, 1.9, 0.3],
    [8.3, 0.7, 0.12],
  ],
  y: [
    [1.3, 2.2, 0.5],
    [2.7, 0.3, 0.32],
    [9.1, 1.4, 0.1],
  ],
};

export const SHEEN_MS = 1600;
export const SHEEN_EASING = "cubic-bezier(0.45, 0, 0.25, 1)";
const CLOUD_FADE_MS = 600;
const INTRO_HOLD_MS = 250;
/** A replay racks out from the sharp word to 3 m over this long. */
const REPLAY_LEAD_MS = 250;

type Ease = (p: number) => number;
const easeInOut: Ease = (p) => (p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2);
const easeOut: Ease = (p) => 1 - (1 - p) ** 3;
const still: Ease = () => 0;

type Move = { toM: number; ms: number; ease: Ease } | { holdMs: number };

/**
 * The pull, after the lens starts at 3 m, about half a second in all: a fast
 * rack well past the word to 40 m, a beat, a correction back past it to 13 m,
 * another beat, then a settle on 20 m.
 */
export const FOCUS_PULL: readonly Move[] = [
  { toM: 40, ms: 200, ease: easeInOut },
  { holdMs: 40 },
  { toM: 13, ms: 120, ease: easeInOut },
  { holdMs: 30 },
  { toM: 20, ms: 110, ease: easeOut },
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
      : { toM: START_M, ms: REPLAY_LEAD_MS, ease: easeInOut };
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

const tremor = (waves: readonly Wave[], ms: number) =>
  waves.reduce(
    (sum, [hz, phase, weight]) =>
      sum + weight * Math.sin(2 * Math.PI * hz * (ms / 1000) + phase),
    0,
  );

/**
 * The camera's offset, in em, at a time into a play: the drift onto the word
 * plus the tremor, both gone once focus has locked. A replay starts from a
 * steady camera, so its shake rises over the rack out instead of jumping.
 */
export const shakeAt = (play: FocusPlay, ms: number) => {
  const focusEnd = focusMs(play);
  if (ms >= focusEnd) return { x: 0, y: 0 };
  const lead = segments(play)[0].ms;
  const rise = play === "replay" ? easeInOut(Math.min(1, ms / lead)) : 1;
  const steadying = (1 - ms / focusEnd) ** 1.5;
  const swing =
    Math.exp(-ms / AIM_SETTLE_MS) * Math.cos(2 * Math.PI * AIM_SWING_HZ * (ms / 1000));
  const axis = (start: number, waves: readonly Wave[]) =>
    SHAKE_EM * rise * steadying * (start * swing + tremor(waves, ms));
  return { x: axis(AIM_START.x, TREMOR.x), y: axis(AIM_START.y, TREMOR.y) };
};

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
    const shake = shakeAt(play, t);
    const scale = `scale(${round((1 + BREATHING_PER_DIOPTRE * (lens - 1 / SUBJECT_M)) * 100) / 100})`;
    const em = (v: number) => `${Math.round(v * 1000) / 1000 || 0}em`;
    const transform = `translate(${em(shake.x)}, ${em(shake.y)}) ${scale}`;
    const fadeIn = play === "replay" ? Math.min(1, t / lead) : 1;
    const fadeOut = t <= focusEnd ? 1 : 1 - (t - focusEnd) / CLOUD_FADE_MS;
    word.push({
      offset,
      filter: `blur(${round(blurPx(lens, SUBJECT_M))}px)`,
      transform,
    });
    clouds.push({
      offset,
      filter: `blur(${round(blurPx(lens, CLOUDS_M) + CLOUD_SOFTNESS_PX)}px)`,
      transform,
      opacity: round(Math.min(fadeIn, fadeOut)),
    });
  }
  return { word, clouds, durationMs };
};
