/**
 * Power-iteration PCA that reduces N high-dimensional vectors to 3 components.
 * Uses deflated power iteration so it never materializes a D×D covariance
 * matrix — only N×D passes per component, which is fast when N (clusters) << D (512).
 */
export function computePCA3D(vectors: Float32Array<ArrayBuffer>[]): [number, number, number][] {
  const N = vectors.length;
  if (N === 0) return [];
  const D = vectors[0].length;

  if (N === 1) return [[0, 0, 0]];
  if (N === 2) return [[-1, 0, 0], [1, 0, 0]];

  // Center the data
  const mean = new Float32Array(D) as Float32Array<ArrayBuffer>;
  for (const v of vectors) for (let d = 0; d < D; d++) mean[d] += v[d];
  for (let d = 0; d < D; d++) mean[d] /= N;

  const residuals: Float32Array<ArrayBuffer>[] = vectors.map((v) => {
    const c = new Float32Array(D) as Float32Array<ArrayBuffer>;
    for (let d = 0; d < D; d++) c[d] = v[d] - mean[d];
    return c;
  });

  const dot = (a: Float32Array<ArrayBuffer>, b: Float32Array<ArrayBuffer>): number => {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  };

  const normalize = (v: Float32Array<ArrayBuffer>): Float32Array<ArrayBuffer> => {
    const mag = Math.sqrt(dot(v, v));
    if (mag < 1e-10) return v;
    const out = new Float32Array(v.length) as Float32Array<ArrayBuffer>;
    for (let i = 0; i < v.length; i++) out[i] = v[i] / mag;
    return out;
  };

  const components: Float32Array<ArrayBuffer>[] = [];

  for (let k = 0; k < 3; k++) {
    // Deterministic seeded init (avoids randomness-dependent output)
    let pc: Float32Array<ArrayBuffer> = new Float32Array(D);
    for (let d = 0; d < D; d++) {
      const t = Math.sin((k * 31 + d + 1) * 12.9898) * 43758.5453;
      pc[d] = t - Math.floor(t) - 0.5;
    }
    pc = normalize(pc);

    // Power iteration: pc ← normalize(X^T (X pc))
    for (let iter = 0; iter < 60; iter++) {
      const scores = residuals.map((r) => dot(r, pc));
      const newPc = new Float32Array(D) as Float32Array<ArrayBuffer>;
      for (let i = 0; i < N; i++) {
        const s = scores[i];
        const r = residuals[i];
        for (let d = 0; d < D; d++) newPc[d] += s * r[d];
      }
      pc = normalize(newPc);
    }

    components.push(pc);

    // Deflate residuals: subtract projection onto this component
    for (const r of residuals) {
      const proj = dot(r, pc);
      for (let d = 0; d < D; d++) r[d] -= proj * pc[d];
    }
  }

  // Project centered vectors onto the 3 components
  const centered: Float32Array<ArrayBuffer>[] = vectors.map((v) => {
    const c = new Float32Array(D) as Float32Array<ArrayBuffer>;
    for (let d = 0; d < D; d++) c[d] = v[d] - mean[d];
    return c;
  });

  return centered.map((c) => [
    dot(c, components[0]),
    dot(c, components[1]),
    dot(c, components[2]),
  ]);
}
