/** Transcript segments as a WebVTT caption track. */
export const segmentsToWebVTT = (
  segments: Array<{ start: number; end: number; text: string }>,
): string => {
  const toTimestamp = (s: number): string => {
    const h = Math.floor(s / 3600)
      .toString()
      .padStart(2, "0");
    const m = Math.floor((s % 3600) / 60)
      .toString()
      .padStart(2, "0");
    const sec = Math.floor(s % 60)
      .toString()
      .padStart(2, "0");
    const ms = Math.round((s % 1) * 1000)
      .toString()
      .padStart(3, "0");
    return `${h}:${m}:${sec}.${ms}`;
  };
  const cues = segments
    .map(
      (seg, i) =>
        `${i + 1}\n${toTimestamp(seg.start)} --> ${toTimestamp(seg.end)}\n${seg.text}`,
    )
    .join("\n\n");
  return `WEBVTT\n\n${cues}`;
};
