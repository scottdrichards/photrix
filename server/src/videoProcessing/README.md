# videoProcessing

Everything ffmpeg does to a video: probing it, single frames, on-demand HLS,
share exports and the frames the face pass looks at.

| File | What it owns |
| --- | --- |
| `getVideoMetadata.ts` | ffprobe with a timeout; `VideoSourceProfile` (rotation, codec, bit depth, HDR) |
| `gpuAcceleration.ts` | which hardware encoder/decoder to use (NVENC, VAAPI, AMF) and its ffmpeg args |
| `hlsService.ts` | `serveHls`: answers one HLS request (master, variant playlist or segment) as a typed result the handler maps to a response |
| `hlsEncodeQueue.ts` | claims an encode for a variant and queues it on the orchestrator's blocking queue |
| `hlsPlaylistRewrite.ts`, `hlsSegmentNames.ts` | points ffmpeg's playlists at the files API; `segment_NNN.ts` names |
| `generateMultibitrateHLS.ts` | one on-demand ffmpeg encode per HLS variant (360p/720p/1080p) |
| `buildHlsPlaylist.ts`, `hlsOutputFrameRate.ts` | the synthetic VOD playlist and the output frame rate |
| `hlsSession.ts` | encode lifecycle: kill an idle encode, delete an idle tree, restart on a far seek |
| `hlsSegmentWatcher.ts` | lets a segment request wait for the encoder to write it |
| `videoUtils.ts` | thumbnail and scrub-frame extracts (tonemapped for HDR) |
| `videoStoryboard.ts` | the scrub storyboard JPEG (layout in `shared/video-storyboard`) |
| `exportShareVideo.ts` | the web-safe download offered by the share dialog |
| `extractAnalysisFrames.ts` | picks the few frames `videoFaceAnalysis/` runs faces on |

Served through `requestHandlers/files/videoRepresentations.ts` (`tryHLSStream`,
`tryVideoThumbnail`, …), which only parses the request and maps the result;
playback negotiation is `requestHandlers/video/`. The end to end flow is "Video
playback" in `/documentation/ARCHITECTURE.md`.

- HLS encodes are queued by `hlsEncodeQueue.ts` on the task orchestrator's
  **blocking** queue, so playback never waits behind background work. A GPU encode first reclaims
  VRAM from the background ML workers (`ensureGpuHeadroom`).
- Every ffmpeg/ffprobe run has a timeout: a damaged file or a stalled read from
  a network share must not hold a conversion slot forever.
- HLS output is ephemeral and lives under `CACHE_DIR`; nothing here writes next
  to the originals.
