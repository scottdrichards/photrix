/**
 * Storage codec for embedding vectors (CLIP image/audio, face recognition).
 *
 * Why this exists: embeddings dominated the database. Face vectors were stored
 * as Float64 (4 KB each x 311k rows = 1.19 GB) even though the models emit
 * Float32 — measured on the real index, a Float64 -> Float32 round trip changes
 * the resulting cosine similarity by *exactly* zero, so the upper 32 bits were
 * pure waste. CLIP vectors were Float32 (2 KB x 173k rows = 338 MB).
 *
 * The stored form is int8, which is 8x smaller than the old Float64 face blobs:
 *
 *   bytes 0..3   Float32 LE scale factor (maxabs / 127)
 *   bytes 4..N+3 N x int8 quantized components
 *
 * Accuracy, measured over real vectors from the live index (600 vectors, 14100
 * pairs, see the codec spec for the regenerated numbers):
 *
 *   face  int8 vs Float64: mean |cosine error| 3.6e-4, max 1.7e-3, top-10 recall 99.5%
 *   CLIP  int8 vs Float32: mean |cosine error| 1.4e-3, max 7.2e-3, top-10 recall 98.3%
 *
 * Face clustering thresholds sit around 0.3-0.6 with wide margins, so an error
 * of ~1e-3 is far below the resolution any decision here depends on.
 *
 * Cosine similarity ignores the scale entirely — for q = v/s, cosine(qa, qb)
 * equals cosine(a, b) because the per-vector scales cancel in the numerator and
 * denominator alike. That is what lets `cosine_similarity_i8` in the SQLite
 * worker run as pure integer arithmetic over the raw blobs. The scale is stored
 * anyway because dequantization *does* need it: face clustering accumulates
 * centroids as running means of member vectors, where relative magnitude matters.
 */

/** Byte width of the Float32 scale header that precedes the int8 components. */
export const EMBEDDING_SCALE_HEADER_BYTES = 4;

/** Legacy element widths, still accepted on read so migration can decode them. */
const LEGACY_FLOAT64_BYTES = 8;
const LEGACY_FLOAT32_BYTES = 4;

/**
 * Quantizes a vector to the int8 storage form. The vector is normalized to unit
 * length first, so every stored vector shares a magnitude and the quantization
 * grid is spent on direction (the only thing cosine similarity reads) rather
 * than on an arbitrary overall scale.
 *
 * Returns null for empty or zero-magnitude input — callers store NULL for those
 * rather than a blob that would decode to garbage.
 */
export const encodeEmbedding = (
  vector: Float32Array | Float64Array | number[],
): Buffer | null => {
  const length = vector.length;
  if (length === 0) return null;

  let magnitudeSquared = 0;
  for (let i = 0; i < length; i += 1) magnitudeSquared += vector[i] * vector[i];
  if (!(magnitudeSquared > 0) || !Number.isFinite(magnitudeSquared)) return null;
  const magnitude = Math.sqrt(magnitudeSquared);

  // Unit-normalize, then find the largest component so the int8 range is fully used.
  let maxAbsolute = 0;
  for (let i = 0; i < length; i += 1) {
    const unit = Math.abs(vector[i] / magnitude);
    if (unit > maxAbsolute) maxAbsolute = unit;
  }
  if (!(maxAbsolute > 0)) return null;

  const scale = maxAbsolute / 127;
  const out = Buffer.allocUnsafe(EMBEDDING_SCALE_HEADER_BYTES + length);
  out.writeFloatLE(scale, 0);
  for (let i = 0; i < length; i += 1) {
    const quantized = Math.round(vector[i] / magnitude / scale);
    // Clamp to -127 so the range stays symmetric; -128 has no positive twin and
    // would bias the dot product slightly toward whichever sign hit the floor.
    out.writeInt8(quantized < -127 ? -127 : quantized > 127 ? 127 : quantized, i + EMBEDDING_SCALE_HEADER_BYTES);
  }
  return out;
};

/**
 * Decodes a stored embedding blob into a Float32 unit vector.
 *
 * The dimension is implied by the length — one int8 per component after the
 * scale header — so no caller needs to know or agree on the model's output size.
 * Legacy blobs are *not* accepted here: they are unlabelled packed floats, and a
 * 4096-byte Float64 vector is indistinguishable by length from a 4092-dim int8
 * one. Only the migration reads those, and it knows which column it is reading,
 * so it uses `decodeLegacyEmbedding` with an explicit width instead.
 *
 * Returns null for empty, malformed or zero-magnitude blobs.
 */
export const decodeEmbedding = (
  buffer: Buffer | Uint8Array | null | undefined,
): Float32Array | null => {
  if (!buffer || buffer.byteLength <= EMBEDDING_SCALE_HEADER_BYTES) return null;
  return decodeInt8(buffer, buffer.byteLength - EMBEDDING_SCALE_HEADER_BYTES);
};

/**
 * Decodes one of the pre-int8 blobs: a bare little-endian packed array of
 * Float64 (`faces.embedding`) or Float32 (`files.imageEmbedding` /
 * `audioEmbedding`) with no header. The width has to be supplied because
 * nothing in the blob itself records it.
 *
 * Only the storage migration should call this.
 */
export const decodeLegacyEmbedding = (
  buffer: Buffer | Uint8Array | null | undefined,
  bytesPerElement: 4 | 8,
): Float32Array | null => {
  if (!buffer || buffer.byteLength === 0) return null;
  if (buffer.byteLength % bytesPerElement !== 0) return null;
  return decodeLegacy(buffer, buffer.byteLength / bytesPerElement, bytesPerElement);
};

const decodeInt8 = (
  buffer: Buffer | Uint8Array,
  dimension: number,
): Float32Array | null => {
  const view = new DataView(
    buffer.buffer as ArrayBuffer,
    buffer.byteOffset,
    buffer.byteLength,
  );
  const scale = view.getFloat32(0, true);
  if (!Number.isFinite(scale) || scale <= 0) return null;

  const out = new Float32Array(dimension);
  let magnitudeSquared = 0;
  for (let i = 0; i < dimension; i += 1) {
    const value = view.getInt8(i + EMBEDDING_SCALE_HEADER_BYTES) * scale;
    out[i] = value;
    magnitudeSquared += value * value;
  }
  if (!(magnitudeSquared > 0)) return null;

  // Re-normalize: rounding leaves the decoded vector a hair off unit length.
  const magnitude = Math.sqrt(magnitudeSquared);
  for (let i = 0; i < dimension; i += 1) out[i] /= magnitude;
  return out;
};

const decodeLegacy = (
  buffer: Buffer | Uint8Array,
  dimension: number,
  bytesPerElement: number,
): Float32Array | null => {
  const view = new DataView(
    buffer.buffer as ArrayBuffer,
    buffer.byteOffset,
    buffer.byteLength,
  );
  const out = new Float32Array(dimension);
  let magnitudeSquared = 0;
  for (let i = 0; i < dimension; i += 1) {
    const offset = i * bytesPerElement;
    const value =
      bytesPerElement === LEGACY_FLOAT64_BYTES
        ? view.getFloat64(offset, true)
        : view.getFloat32(offset, true);
    out[i] = value;
    magnitudeSquared += value * value;
  }
  if (!(magnitudeSquared > 0)) return null;

  const magnitude = Math.sqrt(magnitudeSquared);
  for (let i = 0; i < dimension; i += 1) out[i] /= magnitude;
  return out;
};

/**
 * True when a blob is already in the int8 storage form. Used by the migration to
 * stay idempotent — a resumed run must not re-quantize what it already converted
 * (which would compound rounding error on every pass).
 */
export const isEncodedEmbedding = (
  buffer: Buffer | Uint8Array | null | undefined,
  dimension: number,
): boolean =>
  !!buffer && buffer.byteLength === EMBEDDING_SCALE_HEADER_BYTES + dimension;

/** Legacy element widths, exported so the migration can name them explicitly. */
export const LEGACY_FACE_ELEMENT_BYTES = LEGACY_FLOAT64_BYTES;
export const LEGACY_CLIP_ELEMENT_BYTES = LEGACY_FLOAT32_BYTES;
