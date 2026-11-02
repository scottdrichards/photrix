import { encodeEmbedding } from "./embeddingCodec.ts";

/**
 * Packs the CLIP vectors of a video's sampled frames into the one
 * `fileEmbeddings.videoFrameEmbeddings` blob for that video (feedback #150).
 * Keeping them on the video's own row means every path that deletes, moves or
 * resyncs a file's embeddings carries the frames along with no extra SQL.
 *
 * Layout, little-endian: a u32 frame count, then per frame a u32 time (ms
 * into the video), a u32 byte length, and the vector as embeddingCodec
 * encodes it (int8 with its scale header).
 */

export type EncodedVideoFrame = { timeMs: number; embedding: Uint8Array };

const U32 = 4;

/** Null when there is no frame to store. */
export const encodeVideoFrameEmbeddings = (
  frames: ReadonlyArray<{ timeMs: number; embedding: Float32Array }>,
): Buffer | null => {
  const encoded = frames.flatMap(({ timeMs, embedding }) => {
    const vector = encodeEmbedding(embedding);
    return vector ? [{ timeMs: Math.max(0, Math.round(timeMs)), vector }] : [];
  });
  if (encoded.length === 0) return null;
  const size = U32 + encoded.reduce((sum, { vector }) => sum + 2 * U32 + vector.byteLength, 0);
  const out = Buffer.alloc(size);
  let at = out.writeUInt32LE(encoded.length, 0);
  for (const { timeMs, vector } of encoded) {
    at = out.writeUInt32LE(timeMs, at);
    at = out.writeUInt32LE(vector.byteLength, at);
    at += vector.copy(out, at);
  }
  return out;
};

/** The frames in a blob, in stored order. Throws on a blob that doesn't add up. */
export const decodeVideoFrameEmbeddings = (
  blob: Uint8Array | null | undefined,
): EncodedVideoFrame[] => {
  if (!blob || blob.byteLength < U32) return [];
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const count = view.getUint32(0, true);
  const frames: EncodedVideoFrame[] = [];
  let at = U32;
  for (let i = 0; i < count; i++) {
    if (at + 2 * U32 > blob.byteLength) throw new Error("Video frame embeddings truncated");
    const timeMs = view.getUint32(at, true);
    const length = view.getUint32(at + U32, true);
    at += 2 * U32;
    if (at + length > blob.byteLength) throw new Error("Video frame embeddings truncated");
    frames.push({ timeMs, embedding: blob.subarray(at, at + length) });
    at += length;
  }
  return frames;
};
