# On-Demand DASH Streaming

This directory implements an on-demand MPEG-DASH pipeline that creates the MPD manifest instantly and only begins GPU accelerated transcoding (using `h264_amf`) when the first initialization or media segment is requested by the client.

## High-Level Flow
1. Client requests `video.mp4.mpd`.
2. Server returns a synthesized MPD XML immediately (no ffmpeg startup delay) describing available representations and segment template.
3. Segments and init files are named using a stable slug derived from the base filename to avoid collisions: `<slug>-init-0.m4s`, `<slug>-chunk-0-1.m4s`, `<slug>-init-1.m4s`, etc. (numeric representation IDs).
4. When the player requests the first init or media segment, the server starts an ffmpeg process (if not already running) that encodes & fragments the source file into CMAF-style segments in the cache directory.
4. Segment requests poll briefly (up to 10s) for the segment file to appear; once written by ffmpeg they are served directly from disk.
5. Sessions auto-expire after 5 minutes of inactivity and the ffmpeg process is terminated.

## Files
- `dashSessionManager.ts` – Manages session state, ffmpeg spawning, MPD generation, and segment availability.
- `dashConstants.ts` – Configuration (bitrates, segment duration, codec identifiers).

## FFMPEG Command Strategy
We let ffmpeg's DASH muxer emit `slug-init-$RepresentationID$.m4s` and `slug-chunk-$RepresentationID$-$Number$.m4s` (slug injected at runtime) while we IGNORE the auto-generated MPD (`temp.mpd`) and serve our custom MPD instead. This gives us full control of manifest structure while still leveraging the muxer's fragmenting logic. Representation IDs are numeric (`0`, `1`, `2`, ...) to match ffmpeg's internal ordering; audio (if present) uses the next numeric ID after the last video representation.

Representations are derived from `dashConfig.videoQualityOptions`, filtered to avoid upscaling beyond the source resolution.

## Extending
- Add more renditions: entries in `videoQualityOptions` (ordered lowest→highest). Server auto-filters those larger than the source. You can cap how many are used via `DASH_MAX_REPRESENTATIONS` environment variable (default 4).
- Add audio adaptation sets with multiple bitrates (currently single AAC rendition).
- Implement live mode by adjusting MPD `type` and enabling sliding window parameters; switch from `static` to `dynamic`.
- Add seek optimization: pre-generate keyframe index or implement `-force_key_frames` expression tuned to segment duration.

## Cleanup / Stability
Sessions are keyed by the source relative path and expose a slug used in all segment file names. Idle sessions are cleaned after 5 minutes. If ffmpeg exits, the session is marked closed and will be recreated on the next request.

Note: If the representation ID scheme changes (e.g., from `v0` style to numeric) you should restart the server to clear any in-memory sessions using the old naming, otherwise the MPD returned to existing clients may reference files that won't be produced.

## Fallbacks
If `h264_amf` fails (driver missing or unsupported), a future enhancement could attempt `libx264` automatically.

## Known Limitations
- MPD bandwidth values are approximate; consider probing actual output bitrate for accuracy.
- Only one audio rendition.
- No per-segment availability time; the MPD is VOD style (`type="static"`).
- Segment numbering starts at 1; no timeline segments.

## Future Ideas
See repository TODOs or open issues for multi-bitrate, HDR handling, DRM integration, and segment caching policies.
