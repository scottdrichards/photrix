import {
  blurPx,
  CLOUDS_M,
  focusKeyframes,
  focusMs,
  lensDioptresAt,
  START_M,
  SUBJECT_M,
  type FocusPlay,
} from "./wordmarkFocus";

const metresAt = (play: FocusPlay, ms: number) => 1 / lensDioptresAt(play, ms);
const plays: FocusPlay[] = ["intro", "replay"];

/** Every millisecond of the focus pull. */
const lensPath = (play: FocusPlay) =>
  Array.from({ length: Math.ceil(focusMs(play)) + 1 }, (_, ms) =>
    lensDioptresAt(play, ms),
  );

describe("wordmark focus optics", () => {
  it("pulls from 3 m out to 25 m, back to 18 m, and settles on 20 m", () => {
    const path = lensPath("intro").map((d) => 1 / d);
    expect(path[0]).toBeCloseTo(START_M);
    const furthest = Math.max(...path);
    expect(furthest).toBeCloseTo(25, 1);
    const afterOvershoot = path.slice(path.indexOf(furthest));
    expect(Math.min(...afterOvershoot)).toBeCloseTo(18, 1);
    expect(path[path.length - 1]).toBeCloseTo(SUBJECT_M);
  });

  it("starts a replay from the sharp word and racks out to 3 m first", () => {
    expect(metresAt("replay", 0)).toBeCloseTo(SUBJECT_M);
    expect(Math.min(...lensPath("replay").map((d) => 1 / d))).toBeCloseTo(START_M, 1);
  });

  it("never brings the clouds into focus", () => {
    for (const play of plays) {
      const sharpest = Math.min(...lensPath(play).map((d) => blurPx(d, CLOUDS_M)));
      expect(sharpest).toBeGreaterThan(0.8);
    }
  });

  it("ends with the word sharp, and its misses near 20 m stay subtle", () => {
    for (const play of plays) {
      const path = lensPath(play);
      expect(blurPx(path[path.length - 1], SUBJECT_M)).toBeCloseTo(0);
      expect(blurPx(1 / 25, SUBJECT_M)).toBeLessThan(0.3);
      expect(blurPx(1 / 18, SUBJECT_M)).toBeLessThan(0.3);
    }
    expect(blurPx(1 / START_M, SUBJECT_M)).toBeGreaterThan(5);
  });

  it("builds keyframes from 0 to 1 that agree on the timeline for both planes", () => {
    for (const play of plays) {
      const { word, clouds } = focusKeyframes(play);
      expect(word[0].offset).toBe(0);
      expect(word[word.length - 1].offset).toBe(1);
      expect(clouds.map((k) => k.offset)).toEqual(word.map((k) => k.offset));
      const offsets = word.map((k) => k.offset as number);
      expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
      expect(clouds[clouds.length - 1].opacity).toBe(0);
    }
  });
});
