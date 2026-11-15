/** Copies a possibly-unaligned BLOB into an aligned Float32Array view. */
export const toAlignedFloat32 = (buffer: Buffer | Uint8Array): Float32Array => {
  const aligned = new Uint8Array(buffer.byteLength);
  aligned.set(buffer);
  return new Float32Array(aligned.buffer);
};
