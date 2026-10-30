# Where does X happen?

A map for finding code fast. Each module's own `README.md` holds the detail;
this page only points at it. If you add a route, background stage, or
diagnostics event, add a row here.

## Request path (server)

`server/src/main.ts` boots everything → `createServer.ts` runs every request
through `runWithRequestTrace` (request id, spans, perf stats), the auth gate,
the user-activity bracket for the task orchestrator, then a flat list of
`if (route) await handler(...)` blocks.

| Route                                    | Handler (`server/src/requestHandlers/`)             | Does the work in                                                                                         |
| ---------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `GET /api/files/<dir>/?…` (trailing `/`) | `files/queryHandler.ts`                             | `indexDatabase/indexDatabase.ts` `queryFiles`, `filterToSQL.ts`                                          |
| `GET /api/files/<file>?representation=…` | `files/filesRequestHandler.ts` `fileHandler`        | see "Serving a file" below                                                                               |
| `PATCH /api/files/<file>`                | `files/updateMetadataHandler.ts`                    | `indexDatabase.ts`                                                                                       |
| `GET /api/folders/…`                     | `foldersRequestHandler.ts`                          | `indexDatabase.ts`                                                                                       |
| `GET /api/search`                        | `searchRequestHandler.ts`                           | CLIP text embedding (`imageAnalysis/`), CLAP (`audioProcessing/clapWorker.ts`), `naturalLanguageSearch/` |
| `POST /api/search/interpret`             | `searchInterpretHandler.ts`                         | `naturalLanguageSearch/interpretSearchQuery.ts`                                                          |
| `POST /api/page-title`                   | `pageTitleHandler.ts`                               | describes the current filter for the header                                                              |
| `GET /api/suggestions`                   | `suggestionsRequestHandler.ts`                      | `indexDatabase.ts`                                                                                       |
| `GET /api/video/negotiate`               | `video/videoNegotiation.ts`                         | direct vs live GPU HLS decision                                                                          |
| `/api/faces/…`                           | `faceIdentifyRequestHandler.ts`                     | `faceDetection/`, `indexDatabase/faceReview.ts`                                                          |
| `/api/people/…`                          | `peopleRequestHandler.ts`                           | `indexDatabase/faceClusterEngine.ts`                                                                     |
| `POST /api/moment-clusters/…`            | `momentClustersRequestHandler.ts`                   | `indexDatabase/momentClusterEngine.ts`                                                                   |
| `GET /api/photos/caption`                | `photoCaptionRequestHandler.ts`                     | `photoCaption/` (Ollama)                                                                                 |
| `GET /api/photos/suggest-rotation`       | `suggestRotationRequestHandler.ts`                  | `imageProcessing/suggestRotation.ts`                                                                     |
| `GET /api/day-photo/…`                   | `dayPhotoRequestHandler.ts`                         | `scripts/dayPhoto/`                                                                                      |
| `/api/settings/…`                        | `settingsRequestHandler.ts`                         | `settings` table                                                                                         |
| `/api/auth/…`, `/api/account`            | `authRequestHandler.ts`, `accountRequestHandler.ts` | `auth/`                                                                                                  |
| `GET /share`                             | `sharePreviewHandler.ts`                            | `shareDescription/`                                                                                      |
| `/api/status`, `/api/status/stream`      | `statusRequestHandler.ts`                           | `observability/systemMetrics.ts`, task orchestrator snapshot                                             |
| `GET /api/network-probe`                 | `networkProbeRequestHandler.ts`                     | bytes for the client's bandwidth measurement                                                             |
| `/api/feedback[/:id[/diagnostics]]`      | `feedbackHandler.ts`                                | `feedback` table; saves a diagnostics report per suggestion                                              |
| `/api/diagnostics/events`                | `diagnosticsRequestHandler.ts`                      | `observability/diagnosticsStore.ts`                                                                      |
| `GET /api/diagnostics/perf`, `…/report`  | `diagnosticsReportRequestHandler.ts`                | `observability/perfMonitor.ts`, `observability/buildDiagnosticsReport.ts`                                |

### Serving a file (`filesRequestHandler.ts`)

`fileHandler` tries each representation in turn; the first that claims the
request answers it.

| `representation=`                          | Function                            | Produced by                                                                    |
| ------------------------------------------ | ----------------------------------- | ------------------------------------------------------------------------------ |
| `preview` / `webSafe` / `?height=` (image) | `tryImageVariant`                   | `imageProcessing/convertImage.ts` (sharp, Python for HEIC/RAW), cached on disk |
| `micro`                                    | `tryMicroThumbnail`                 | embedded EXIF thumbnail (`imageProcessing/embeddedThumbnail.ts`)               |
| `preview` (video)                          | `tryVideoThumbnail`                 | `videoProcessing/videoUtils.ts` (ffmpeg frame grab)                            |
| `hls` (+ `variant`, `segment`)             | `tryHLSStream`                      | `videoProcessing/generateMultibitrateHLS.ts`, lifecycle in `hlsSession.ts`     |
| `scrub`                                    | inline                              | `videoProcessing/videoUtils.ts`, one cached low-res frame per `index`          |
| `transcript`                               | inline                              | `audioProcessing/processAudioTranscription.ts` output                          |
| `live-photo`                               | inline                              | paired `.mov` / embedded motion photo                                          |
| `crop=` (faces)                            | `tryImageCrop`, `tryVideoFrameCrop` | `imageProcessing/convertImage.ts`                                              |
| none                                       | `streamFile`                        | the original, with range support                                               |

## Video playback, end to end

1. Client opens a video → `client/src/components/viewer/FullscreenViewer.tsx` (the
   "HLS setup effect"). Bandwidth comes from `client/src/videoPlaybackProfile.ts`
   (probed once at app start).
2. `GET /api/video/negotiate` → `videoNegotiation.ts` picks **direct** (link
   can carry the original and the browser can decode it), **live GPU HLS**,
   or **error** (with a reason saying which).
3. HLS: hls.js requests the master → variant playlist → segments from
   `filesRequestHandler.ts` `tryHLSStream`. Each variant is a separate
   on-demand ffmpeg encode (`generateMultibitrateHLS.ts`) at the source's own
   frame rate up to 30fps (`hlsOutputFrameRate.ts`), queued through the
   task orchestrator, killed after 8s unused and deleted after 90s
   (`hlsSession.ts`). Segment requests wait for the encoder
   (`hlsSegmentWatcher.ts`).
4. Client ABR: hls.js, with upswitches held back by `client/src/components/viewer/hlsAbrGuard.ts`.
   A stalled direct stream falls back to HLS after 3s.
5. While loading, `VideoLoadingOverlay.tsx` shows the phase, elapsed time and
   when data last arrived. On close, a `video.playback.summary` event records
   startup time, stalls and dropped frames.

## Background pipeline (server)

Wired in `main.ts` → `backgroundTasks/registerBackgroundTasks.ts`; scheduled
by `taskOrchestrator/` (backs off while a user request is active; see its README).

```
fileSystemScan ─► fileMetadata (indexDatabase/processFileInfo.ts)
               ├► exifMetadata (indexDatabase/processExifMetadata.ts)
               │    ├► audioTranscription (audioProcessing/, Whisper)
               │    ├► audioEmbedding (audioProcessing/, CLAP)
               │    └► videoFaceAnalysis (videoFaceAnalysis/) ─► faceClustering
               ├► imageAnalysis (imageAnalysis/, faces + CLIP, Python worker)
               │    ├► faceClustering (indexDatabase/processFaceClustering.ts)
               │    ├► faceAttributes (imageAnalysis/processFaceAttributes.ts)
               │    └► momentClustering (indexDatabase/processMomentClustering.ts)
               └► thumbnailBackfill (imageProcessing/thumbnailBackfill.ts)
```

File changes after boot: `indexDatabase/fileSystemMonitorFolder.ts` (watcher)
and `fileSystemRescanRecent.ts` re-queue the entry stages.

## Client

| Concern                         | File(s) in `client/src/`                                          |
| ------------------------------- | ----------------------------------------------------------------- |
| App shell, views, routing state | `App.tsx`, `filterUrlState.ts`, `hooks/useSyncUrlWithFilter.ts`   |
| Grid, tiles, hover previews     | `components/grid/` (`ThumbnailGrid.tsx`, `ThumbnailTile.tsx`, `tileMedia/`) |
| Photo/video viewer, editor      | `components/viewer/` (`FullscreenViewer.tsx`, `photoEdit/`)       |
| Filters / search                | `components/filter/`, `components/search/`                        |
| People                          | `components/people/`                                              |
| Map                             | `components/map/`                                                 |
| Status, share, account          | `components/status/`, `components/share/`, `components/account/`  |
| API calls                       | `api/*.ts` (all through `api/http.ts` `fetchWithDiagnostics`)     |
| Diagnostics / perf telemetry    | `diagnostics.ts`, `clientPerf.ts`                                 |

## Something is slow or broken

See `DIAGNOSTICS.md`: pull `GET /api/diagnostics/report?clientSessionId=…`
(or the report saved with a suggestion at `/api/feedback/:id/diagnostics`).
