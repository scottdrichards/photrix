import {
  blurPx,
  CLOUDS_M,
  focusKeyframes,
  focusMs,
  lensDioptresAt,
  shakeAt,
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
  it("pulls from 3 m out to 40 m, back to 13 m, and settles on 20 m", () => {
    const path = lensPath("intro").map((d) => 1 / d);
    expect(path[0]).toBeCloseTo(START_M);
    const furthest = Math.max(...path);
    expect(furthest).toBeCloseTo(40, 0);
    const afterOvershoot = path.slice(path.indexOf(furthest));
    expect(Math.min(...afterOvershoot)).toBeCloseTo(13, 1);
    expect(path[path.length - 1]).toBeCloseTo(SUBJECT_M);
  });

  it("starts a replay from the sharp word and racks out to 3 m first", () => {
    expect(metresAt("replay", 0)).toBeCloseTo(SUBJECT_M);
    expect(Math.min(...lensPath("replay").map((d) => 1 / d))).toBeCloseTo(START_M, 1);
  });

  it("never brings the clouds into focus", () => {
    for (const play of plays) {
      const sharpest = Math.min(...lensPath(play).map((d) => blurPx(d, CLOUDS_M)));
      expect(sharpest).toBeGreaterThan(0.45);
    }
  });

  it("takes about half a second to pull focus, once it starts", () => {
    expect(focusMs("intro") - focusMs("replay")).toBe(0);
    const pull = focusMs("intro") - 250;
    expect(pull).toBeGreaterThanOrEqual(400);
    expect(pull).toBeLessThanOrEqual(600);
  });

  it("ends with the word sharp, and its misses read as misses but stay subtle", () => {
    for (const play of plays) {
      const path = lensPath(play);
      expect(blurPx(path[path.length - 1], SUBJECT_M)).toBeCloseTo(0);
    }
    for (const missM of [40, 13]) {
      expect(blurPx(1 / missM, SUBJECT_M)).toBeGreaterThan(0.5);
      expect(blurPx(1 / missM, SUBJECT_M)).toBeLessThan(1.2);
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

  describe("handheld shake", () => {
    const magnitude = ({ x, y }: { x: number; y: number }) => Math.hypot(x, y);
    const largest = (play: FocusPlay, from: number, to: number) =>
      Math.max(
        ...Array.from({ length: to - from }, (_, i) =>
          magnitude(shakeAt(play, from + i)),
        ),
      );

    it("starts off-aim on load, and steady on a replay", () => {
      expect(magnitude(shakeAt("intro", 0))).toBeGreaterThan(0.05);
      expect(magnitude(shakeAt("replay", 0))).toBe(0);
    });

    it("stays small, steadies as focus locks, and ends dead still", () => {
      for (const play of plays) {
        const end = focusMs(play);
        expect(largest(play, 0, end)).toBeLessThan(0.25);
        const tail = Math.round(end / 5);
        expect(largest(play, end - tail, end)).toBeLessThan(
          largest(play, 0, 2 * tail) / 5,
        );
        expect(shakeAt(play, end)).toEqual({ x: 0, y: 0 });
      }
    });

    it("moves the word and the clouds together", () => {
      for (const play of plays) {
        const { word, clouds } = focusKeyframes(play);
        expect(clouds.map((k) => k.transform)).toEqual(word.map((k) => k.transform));
        expect(word[word.length - 1].transform).toBe("translate(0em, 0em) scale(1)");
      }
    });
  });
});
