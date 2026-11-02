import { describe, expect, it } from "@jest/globals";
import { decodeEmbedding } from "./embeddingCodec.ts";
import {
  decodeVideoFrameEmbeddings,
  encodeVideoFrameEmbeddings,
} from "./videoFrameEmbeddingCodec.ts";

describe("video frame embedding codec", () => {
  it("round-trips each frame's time and vector", () => {
    const blob = encodeVideoFrameEmbeddings([
      { timeMs: 0, embedding: Float32Array.of(1, 0, 0) },
      { timeMs: 12_345.6, embedding: Float32Array.of(0, 0.6, 0.8) },
    ]);
    const frames = decodeVideoFrameEmbeddings(blob);
    expect(frames.map((f) => f.timeMs)).toEqual([0, 12_346]);
    const second = decodeEmbedding(frames[1].embedding)!;
    expect(second[1]).toBeCloseTo(0.6, 1);
    expect(second[2]).toBeCloseTo(0.8, 1);
  });

  it("stores nothing for no frames, and reads nothing back from nothing", () => {
    expect(encodeVideoFrameEmbeddings([])).toBeNull();
    expect(decodeVideoFrameEmbeddings(null)).toEqual([]);
  });

  it("refuses a truncated blob", () => {
    const blob = encodeVideoFrameEmbeddings([{ timeMs: 1, embedding: Float32Array.of(1, 0) }])!;
    expect(() => decodeVideoFrameEmbeddings(blob.subarray(0, blob.byteLength - 1))).toThrow(
      /truncated/,
    );
  });
});
