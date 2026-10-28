/**
 * Integer dot product of `query` against each of the first `rows` rows of a
 * row-major int8 matrix, written into `out`.
 *
 * This loop is the entire cost of a semantic search (~90M multiply-adds for a
 * 177k-photo library), so it is kept as one small pure function with no
 * dependency on the rest of the index: it is the piece to replace with a SIMD
 * native kernel. The int32 sums are exact (512 × 127² < 2³¹), so a replacement
 * must reproduce them bit for bit.
 */
export const dotProducts = (
  matrix: Int8Array,
  dimension: number,
  rows: number,
  query: Int8Array,
  out: Int32Array,
): void => {
  for (let row = 0; row < rows; row++) {
    const offset = row * dimension;
    let sum = 0;
    for (let i = 0; i < dimension; i++) sum += matrix[offset + i] * query[i];
    out[row] = sum;
  }
};
