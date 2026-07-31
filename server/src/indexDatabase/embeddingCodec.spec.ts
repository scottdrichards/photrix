import { describe, expect, it } from "@jest/globals";
import {
  EMBEDDING_SCALE_HEADER_BYTES,
  LEGACY_CLIP_ELEMENT_BYTES,
  LEGACY_FACE_ELEMENT_BYTES,
  decodeEmbedding,
  decodeLegacyEmbedding,
  encodeEmbedding,
  isEncodedEmbedding,
} from "./embeddingCodec.ts";

const DIM = 512;

/** Deterministic pseudo-random vectors, so accuracy assertions are stable. */
const makeVector = (seed: number, dimension = DIM): Float32Array => {
  let state = seed >>> 0;
  const out = new Float32Array(dimension);
  for (let i = 0; i < dimension; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out[i] = state / 0xffffffff - 0.5;
  }
  return out;
};

const cosine = (a: Float32Array, b: Float32Array): number => {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
};

const toFloat64Blob = (vector: Float32Array): Buffer => {
  const out = Buffer.allocUnsafe(vector.length * 8);
  vector.forEach((value, i) => out.writeDoubleLE(value, i * 8));
  return out;
};

const toFloat32Blob = (vector: Float32Array): Buffer => {
  const out = Buffer.allocUnsafe(vector.length * 4);
  vector.forEach((value, i) => out.writeFloatLE(value, i * 4));
  return out;
};

describe("embeddingCodec", () => {
  it("encodes to a scale header plus one byte per dimension", () => {
    const encoded = encodeEmbedding(makeVector(1))!;
    expect(encoded.byteLength).toBe(EMBEDDING_SCALE_HEADER_BYTES + DIM);
    expect(isEncodedEmbedding(encoded, DIM)).toBe(true);
  });

  it("round-trips to a unit vector pointing the same way", () => {
    const original = makeVector(2);
    const decoded = decodeEmbedding(encodeEmbedding(original))!;

    let magnitude = 0;
    for (const value of decoded) magnitude += value * value;
    expect(Math.sqrt(magnitude)).toBeCloseTo(1, 5);
    expect(cosine(original, decoded)).toBeGreaterThan(0.9999);
  });

  it("preserves pairwise cosine similarity within quantization error", () => {
    let worst = 0;
    for (let i = 0; i < 40; i += 1) {
      const a = makeVector(100 + i);
      const b = makeVector(900 + i);
      const exact = cosine(a, b);
      const quantized = cosine(
        decodeEmbedding(encodeEmbedding(a))!,
        decodeEmbedding(encodeEmbedding(b))!,
      );
      worst = Math.max(worst, Math.abs(exact - quantized));
    }
    // Measured ~1e-3 on real face/CLIP vectors; 5e-3 leaves headroom without
    // letting a genuine regression through.
    expect(worst).toBeLessThan(5e-3);
  });

  it("is scale-invariant: a rescaled vector encodes to the same direction", () => {
    const original = makeVector(3);
    const scaled = Float32Array.from(original, (v) => v * 17.5);
    const a = decodeEmbedding(encodeEmbedding(original))!;
    const b = decodeEmbedding(encodeEmbedding(scaled))!;
    expect(cosine(a, b)).toBeGreaterThan(0.99999);
  });

  it("decodes legacy Float64 blobs", () => {
    const original = makeVector(4);
    const decoded = decodeLegacyEmbedding(toFloat64Blob(original), LEGACY_FACE_ELEMENT_BYTES)!;
    expect(decoded).not.toBeNull();
    expect(cosine(original, decoded)).toBeGreaterThan(0.99999);
  });

  it("decodes legacy Float32 blobs", () => {
    const original = makeVector(5);
    const decoded = decodeLegacyEmbedding(toFloat32Blob(original), LEGACY_CLIP_ELEMENT_BYTES)!;
    expect(decoded).not.toBeNull();
    expect(cosine(original, decoded)).toBeGreaterThan(0.99999);
  });

  it("returns null for empty, zero and malformed input", () => {
    expect(encodeEmbedding(new Float32Array(0))).toBeNull();
    expect(encodeEmbedding(new Float32Array(DIM))).toBeNull();
    expect(decodeEmbedding(null)).toBeNull();
    expect(decodeEmbedding(Buffer.alloc(0))).toBeNull();
    // Header with no components carries no vector.
    expect(decodeEmbedding(Buffer.alloc(EMBEDDING_SCALE_HEADER_BYTES))).toBeNull();
    // A zero-scale header decodes to a zero vector, which has no direction.
    expect(
      decodeEmbedding(Buffer.alloc(EMBEDDING_SCALE_HEADER_BYTES + DIM)),
    ).toBeNull();
    // Legacy decode rejects a length that isn't a whole number of elements.
    expect(decodeLegacyEmbedding(Buffer.alloc(7), LEGACY_FACE_ELEMENT_BYTES)).toBeNull();
  });

  it("does not drift when an already-encoded blob is re-encoded", () => {
    // The migration must be safe to resume; re-quantizing must be a no-op.
    const original = makeVector(6);
    const once = encodeEmbedding(original)!;
    const twice = encodeEmbedding(decodeEmbedding(once)!)!;
    expect(cosine(decodeEmbedding(once)!, decodeEmbedding(twice)!))
      .toBeGreaterThan(0.99999);
  });

  it("survives a vector with one dominant component", () => {
    const spiky = new Float32Array(DIM);
    spiky[0] = 1;
    spiky[1] = 1e-4;
    const decoded = decodeEmbedding(encodeEmbedding(spiky))!;
    expect(decoded[0]).toBeCloseTo(1, 3);
  });
});
