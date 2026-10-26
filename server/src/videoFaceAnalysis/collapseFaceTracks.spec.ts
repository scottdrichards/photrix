import { describe, it, expect } from "@jest/globals";
import type { DetectedFace } from "../faceDetection/faceDetector.type.ts";
import {
  APPEARANCE_MERGE_GAP_MS,
  collapseFaceTracks,
  faceQuality,
  MIN_VIDEO_FACE_WIDTH,
  trackAppearances,
  VIDEO_TRACK_SIMILARITY,
  type FrameFaces,
} from "./collapseFaceTracks.ts";

/** A frame at `timeMs` standing for the next second of video. */
const at = (timeMs: number) => ({ timeMs, startMs: timeMs, endMs: timeMs + 1_000 });

/** A unit vector at `angle` radians from a person's reference direction. */
const person = (base: number, angle = 0): Float64Array => {
  const v = new Float64Array(8);
  v[base] = Math.cos(angle);
  v[(base + 1) % 8] = Math.sin(angle);
  return v;
};

const face = (
  embedding: Float64Array,
  {
    size = 0.2,
    confidence = 0.9,
    focus,
  }: { size?: number; confidence?: number; focus?: number } = {},
): DetectedFace => ({
  box: { x: 0.1, y: 0.1, width: size, height: size },
  confidence,
  embedding,
  ...(focus !== undefined ? { attributes: { focus } } : {}),
});

describe("collapseFaceTracks", () => {
  it("keeps one face per person across frames: the most recognisable one", () => {
    const result = collapseFaceTracks([
      { ...at(0), faces: [face(person(0), { size: 0.1 })] },
      { ...at(2_000), faces: [face(person(0, 0.3), { size: 0.3 })] },
      { ...at(4_000), faces: [face(person(0, 0.2), { size: 0.2 })] },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ frameTimeMs: 2_000, box: { width: 0.3 } });
  });

  it("keeps two people apart, ordered by when they first appear", () => {
    const result = collapseFaceTracks([
      { ...at(0), faces: [face(person(0))] },
      { ...at(1_000), faces: [face(person(4)), face(person(0, 0.1))] },
    ]);
    expect(result.map((f) => f.frameTimeMs)).toEqual([0, 1_000]);
    expect(result).toHaveLength(2);
  });

  it("never merges two faces from the same frame, however alike", () => {
    // Twins side by side: near-identical embeddings, but one frame.
    const result = collapseFaceTracks([
      { ...at(0), faces: [face(person(0)), face(person(0, 0.05))] },
    ]);
    expect(result).toHaveLength(2);
  });

  it("splits faces that resemble each other less than the threshold", () => {
    const apart = Math.acos(VIDEO_TRACK_SIMILARITY) + 0.05;
    const result = collapseFaceTracks([
      { ...at(0), faces: [face(person(0))] },
      { ...at(1_000), faces: [face(person(0, apart))] },
    ]);
    expect(result).toHaveLength(2);
  });

  it("follows a head turning across frames through the faces in between", () => {
    // 0 -> 0.6 -> 1.2 rad: neighbours match, the ends alone would not.
    const result = collapseFaceTracks([
      { ...at(0), faces: [face(person(0, 0), { size: 0.3 })] },
      { ...at(1_000), faces: [face(person(0, 0.6))] },
      { ...at(2_000), faces: [face(person(0, 1.2))] },
    ]);
    expect(result).toHaveLength(1);
  });

  it("drops faces without an embedding, which can neither match nor cluster", () => {
    expect(
      collapseFaceTracks([{ ...at(0), faces: [face(new Float64Array(0))] }]),
    ).toEqual([]);
  });

  it("drops background faces too small to recognise", () => {
    const result = collapseFaceTracks([
      {
        timeMs: 0,
        faces: [face(person(0), { size: MIN_VIDEO_FACE_WIDTH * 0.8 }), face(person(4))],
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].embedding[4]).toBe(1);
  });

  it("returns nothing for a video with no faces", () => {
    expect(collapseFaceTracks([{ ...at(0), faces: [] }])).toEqual([]);
  });
});

describe("faceQuality", () => {
  it("prefers bigger, more confident and sharper faces, and reads unknown focus as middling", () => {
    const e = person(0);
    expect(faceQuality(face(e, { size: 0.4 }))).toBeGreaterThan(
      faceQuality(face(e, { size: 0.2 })),
    );
    expect(faceQuality(face(e, { confidence: 0.9 }))).toBeGreaterThan(
      faceQuality(face(e, { confidence: 0.6 })),
    );
    expect(faceQuality(face(e, { focus: 1 }))).toBeGreaterThan(faceQuality(face(e)));
    expect(faceQuality(face(e))).toBeGreaterThan(faceQuality(face(e, { focus: 0 })));
  });
});

describe("trackAppearances", () => {
  const frames = (...windows: Array<[number, number]>): FrameFaces[] =>
    windows.map(([startMs, endMs]) => ({ timeMs: startMs, startMs, endMs, faces: [] }));

  it("covers a run of frames from the first one's start to the last one's end", () => {
    const f = frames([0, 1_000], [1_000, 5_000], [5_000, 6_000], [6_000, 9_000]);
    expect(trackAppearances(f, new Set([1, 2]))).toEqual([
      { startMs: 1_000, endMs: 6_000 },
    ]);
  });

  it("ends a run only at an analysed frame that didn't show them", () => {
    const f = frames([0, 1_000], [10_000, 11_000], [20_000, 21_000], [30_000, 31_000]);
    // Frames thinned out between 1 s and 10 s don't break the run.
    expect(trackAppearances(f, new Set([0, 1, 3]))).toEqual([
      { startMs: 0, endMs: 11_000 },
      { startMs: 30_000, endMs: 31_000 },
    ]);
  });

  it("bridges one missed detection, but not a real exit", () => {
    const short = frames([0, 1_000], [1_000, 2_000], [2_000, 3_000]);
    expect(trackAppearances(short, new Set([0, 2]))).toEqual([
      { startMs: 0, endMs: 3_000 },
    ]);
    const long = frames([0, 10_000], [10_000, 20_000], [20_000, 30_000]);
    expect(trackAppearances(long, new Set([0, 2]))).toHaveLength(2);
    expect(APPEARANCE_MERGE_GAP_MS).toBeLessThan(10_000);
  });
});

describe("collapseFaceTracks appearances", () => {
  it("gives every kept face the stretches its whole track was on screen", () => {
    const [kept] = collapseFaceTracks([
      { ...at(0), faces: [face(person(0), { size: 0.1 })] },
      { ...at(1_000), faces: [face(person(0, 0.2), { size: 0.3 })] },
      { ...at(5_000), faces: [] },
      { ...at(9_000), faces: [face(person(0, 0.1))] },
    ]);
    expect(kept.frameTimeMs).toBe(1_000);
    expect(kept.appearances).toEqual([
      { startMs: 0, endMs: 2_000 },
      { startMs: 9_000, endMs: 10_000 },
    ]);
  });
});
