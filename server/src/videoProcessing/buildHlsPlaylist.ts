/**
 * Length of each HLS segment in seconds. Shared between the FFmpeg `-hls_time`
 * argument and the synthetic playlist builder so the two never drift apart —
 * the builder's segment count must match the segments FFmpeg actually produces.
 *
 * Kept short (1s) to minimize startup latency for on-the-fly encoding: playback
 * can't begin until FFmpeg has encoded and flushed the first whole segment, so a
 * 1s segment halves that floor versus 2s. The encoder's GOP is derived from this
 * (see HLS_GOP in generateMultibitrateHLS) so a keyframe lands on every boundary.
 */
export const HLS_SEGMENT_SECONDS = 1;

/**
 * Builds a complete VOD variant playlist that lists every segment up front and is
 * terminated with `#EXT-X-ENDLIST`, derived purely from the known total duration.
 *
 * Why synthesize instead of serving FFmpeg's playlist: while encoding is in progress
 * FFmpeg emits an EVENT playlist that only lists the segments produced so far and has
 * no `#EXT-X-ENDLIST`, so the player's total duration creeps upward as segments arrive.
 * A VOD playlist listing all segments gives the player the true total length the moment
 * playback starts. Segments that aren't encoded yet are long-polled by the segment
 * handler (see waitForHlsFile) until FFmpeg writes them.
 *
 * The segment count must match what FFmpeg produces: with a fixed 30fps, a keyframe
 * every HLS_SEGMENT_SECONDS (`-g` = fps × segment seconds) and a matching `-hls_time`,
 * segments are cut at exactly HLS_SEGMENT_SECONDS boundaries, so the count is
 * `ceil(duration / segmentSeconds)`
 * and the EXTINF durations sum to the total duration (the last segment is the remainder).
 */
export const buildVodVariantPlaylist = (opts: {
  durationSeconds: number;
  /** Prefix prepended to each `segment_NNN.ts` name (e.g. an API URL). */
  segmentBaseUrl: string;
  segmentSeconds?: number;
}): string => {
  const segmentSeconds = opts.segmentSeconds ?? HLS_SEGMENT_SECONDS;
  const { durationSeconds, segmentBaseUrl } = opts;

  const segmentCount = Math.max(1, Math.ceil(durationSeconds / segmentSeconds));

  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    `#EXT-X-TARGETDURATION:${Math.ceil(segmentSeconds)}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
  ];

  for (let i = 0; i < segmentCount; i++) {
    // Clamp the final segment to the leftover duration so the EXTINF total equals
    // durationSeconds exactly (matching FFmpeg's short trailing segment).
    const segDuration = Math.min(segmentSeconds, durationSeconds - i * segmentSeconds);
    // Matches FFmpeg's `segment_%03d.ts` naming (min width 3, grows past 999).
    const segmentName = `segment_${String(i).padStart(3, "0")}.ts`;
    lines.push(`#EXTINF:${segDuration.toFixed(6)},`);
    lines.push(`${segmentBaseUrl}${segmentName}`);
  }

  lines.push("#EXT-X-ENDLIST");
  return lines.join("\n") + "\n";
};
