/** `segment_NNN.ts`, as ffmpeg names them (min width 3, grows past 999). */
export const segmentFileName = (index: number): string =>
  `segment_${String(index).padStart(3, "0")}.ts`;

/** Extracts the integer index N from an HLS segment name `segment_NNN.ts`. */
export const parseSegmentIndex = (segment: string): number | null => {
  const match = segment.match(/segment_(\d+)\.ts$/);
  return match ? Number(match[1]) : null;
};
