import { describe, it, expect } from "@jest/globals";
import type { DetectedFace } from "../faceDetection/faceDetector.type.ts";
import {
  collapseFaceTracks,
  faceQuality,
  MIN_VIDEO_FACE_WIDTH,
  VIDEO_TRACK_SIMILARITY,
} from "./collapseFaceTracks.ts";

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
      { timeMs: 0, faces: [face(person(0), { size: 0.1 })] },
      { timeMs: 2_000, faces: [face(person(0, 0.3), { size: 0.3 })] },
      { timeMs: 4_000, faces: [face(person(0, 0.2), { size: 0.2 })] },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ frameTimeMs: 2_000, box: { width: 0.3 } });
  });

  it("keeps two people apart, ordered by when they first appear", () => {
    const result = collapseFaceTracks([
      { timeMs: 0, faces: [face(person(0))] },
      { timeMs: 1_000, faces: [face(person(4)), face(person(0, 0.1))] },
    ]);
    expect(result.map((f) => f.frameTimeMs)).toEqual([0, 1_000]);
    expect(result).toHaveLength(2);
  });

  it("never merges two faces from the same frame, however alike", () => {
    // Twins side by side: near-identical embeddings, but one frame.
    const result = collapseFaceTracks([
      { timeMs: 0, faces: [face(person(0)), face(person(0, 0.05))] },
    ]);
    expect(result).toHaveLength(2);
  });

  it("splits faces that resemble each other less than the threshold", () => {
    const apart = Math.acos(VIDEO_TRACK_SIMILARITY) + 0.05;
    const result = collapseFaceTracks([
      { timeMs: 0, faces: [face(person(0))] },
      { timeMs: 1_000, faces: [face(person(0, apart))] },
    ]);
    expect(result).toHaveLength(2);
  });

  it("follows a head turning across frames through the faces in between", () => {
    // 0 -> 0.6 -> 1.2 rad: neighbours match, the ends alone would not.
    const result = collapseFaceTracks([
      { timeMs: 0, faces: [face(person(0, 0), { size: 0.3 })] },
      { timeMs: 1_000, faces: [face(person(0, 0.6))] },
      { timeMs: 2_000, faces: [face(person(0, 1.2))] },
    ]);
    expect(result).toHaveLength(1);
  });

  it("drops faces without an embedding, which can neither match nor cluster", () => {
    expect(
      collapseFaceTracks([{ timeMs: 0, faces: [face(new Float64Array(0))] }]),
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
    expect(collapseFaceTracks([{ timeMs: 0, faces: [] }])).toEqual([]);
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
