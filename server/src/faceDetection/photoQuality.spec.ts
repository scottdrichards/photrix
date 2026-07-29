import { describe, expect, it } from "@jest/globals";
import {
  computePhotoQualityScore,
  faceAttributesToQualityInputs,
  type FaceQualityInputs,
} from "./photoQuality.ts";

const face = (overrides: Partial<FaceQualityInputs> = {}): FaceQualityInputs => ({
  smileScore: null,
  eyesOpenScore: null,
  focusScore: null,
  exposureScore: null,
  ...overrides,
});

describe("computePhotoQualityScore", () => {
  it("returns null for a photo with no faces", () => {
    expect(computePhotoQualityScore([])).toBeNull();
  });

  it("returns null when every face has every attribute unknown", () => {
    expect(computePhotoQualityScore([face(), face()])).toBeNull();
  });

  it("averages the available attributes of a single face", () => {
    const score = computePhotoQualityScore([
      face({ smileScore: 1, eyesOpenScore: 1, focusScore: 0.5, exposureScore: 0.5 }),
    ]);
    expect(score).toBeCloseTo(0.75);
  });

  it("excludes unknown attributes from a face's average rather than penalising them", () => {
    // Only two of four attributes were judged (e.g. a profile view where
    // smile/eyesOpen are meaningless) — the average should be over those two
    // only, not diluted by treating the unknowns as zero.
    const score = computePhotoQualityScore([
      face({ focusScore: 0.9, exposureScore: 0.7 }),
    ]);
    expect(score).toBeCloseTo(0.8);
  });

  it("takes the worst face's score across the photo, not the average", () => {
    const goodFace = face({
      smileScore: 1,
      eyesOpenScore: 1,
      focusScore: 1,
      exposureScore: 1,
    });
    const badFace = face({
      smileScore: 0.1,
      eyesOpenScore: 0.1,
      focusScore: 0.1,
      exposureScore: 0.1,
    });
    // A group photo where one person is fine and another is blurry/blinking
    // should read as a bad photo (matches the worst face), not an
    // averaged-out mediocre one — that's the whole point of using min() here.
    expect(computePhotoQualityScore([goodFace, badFace])).toBeCloseTo(0.1);
  });

  it("ignores an unjudgeable face when other faces have real scores", () => {
    const scoredFace = face({
      smileScore: 0.6,
      eyesOpenScore: 0.6,
      focusScore: 0.6,
      exposureScore: 0.6,
    });
    const unjudgeableFace = face();
    expect(
      computePhotoQualityScore([scoredFace, unjudgeableFace]),
    ).toBeCloseTo(0.6);
  });
});

describe("faceAttributesToQualityInputs", () => {
  it("maps FaceAttributes keys to their column-shaped equivalents", () => {
    expect(
      faceAttributesToQualityInputs({
        smile: 0.9,
        eyesOpen: 0.8,
        focus: 0.7,
        exposure: 0.6,
      }),
    ).toEqual({
      smileScore: 0.9,
      eyesOpenScore: 0.8,
      focusScore: 0.7,
      exposureScore: 0.6,
    });
  });

  it("maps missing attributes to null", () => {
    expect(faceAttributesToQualityInputs(undefined)).toEqual({
      smileScore: null,
      eyesOpenScore: null,
      focusScore: null,
      exposureScore: null,
    });
    expect(faceAttributesToQualityInputs({})).toEqual({
      smileScore: null,
      eyesOpenScore: null,
      focusScore: null,
      exposureScore: null,
    });
  });
});
