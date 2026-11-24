# Where does X happen?

A map for finding code fast. Each module's own `README.md` holds the detail;
this page only points at it. If you add a route, background stage, or
diagnostics event, add a row here.

## Request path (server)

`server/src/main.ts` boots everything → `createServer.ts` runs every request
through `runWithRequestTrace` (request id, spans, perf stats), the auth gate
and the user-activity bracket for the task orchestrator, then dispatches to the
first matching route in `createRoutes.ts`. Each route there declares what a
share link may do with it (`forbidden`, `allowed`, or `scoped` to the share's
filter), so that file is also the share-link access policy.

| Route                                    | Handler (`server/src/requestHandlers/`)             | Does the work in                                                                                         |
| ---------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `GET /api/files/<dir>/?…` (trailing `/`) | `files/queryHandler.ts`                             | `indexDatabase/fileQueryStore.ts` `queryFiles`, `filterToSQL.ts`                                          |
| `GET /api/files/<file>?representation=…` | `files/filesRequestHandler.ts` `fileHandler`        | see "Serving a file" below                                                                               |
| `PATCH /api/files/<file>`                | `files/updateMetadataHandler.ts`                    | `indexDatabase/fileStore.ts` `updateUserMetadata`                                                                                     |
| `GET /api/folders/…`                     | `foldersRequestHandler.ts`                          | `indexDatabase/statsStore.ts` `getFolders`                                                                                     |
| `GET /api/search`                        | `searchRequestHandler.ts`                           | CLIP text embedding (`imageAnalysis/`), CLAP (`audioProcessing/clapWorker.ts`), `naturalLanguageSearch/` |
| `POST /api/search/interpret`             | `searchInterpretRequestHandler.ts`                  | `naturalLanguageSearch/interpretSearchQuery.ts`                                                          |
| `POST /api/page-title`                   | `pageTitleRequestHandler.ts`                        | describes the current filter for the header                                                              |
| `GET /api/suggestions`                   | `suggestionsRequestHandler.ts`                      | `indexDatabase/suggestionStore.ts`                                                                                     |
| `GET /api/video/negotiate`               | `video/videoNegotiation.ts`                         | direct vs live GPU HLS decision                                                                          |
| `/api/faces/…`                           | `faceIdentifyRequestHandler.ts`                     | `people/identify/` (frames, SSRF guard, scoring); centroids from `people/store/peopleQueries.ts` |
| `/api/people/…`                          | `peopleRequestHandler.ts`                           | `people/store/faceClusterStore.ts` (facade over the people stores)                                       |
| `POST /api/moment-clusters/…`            | `momentClustersRequestHandler.ts`                   | `indexDatabase/momentClusterEngine.ts`                                                                   |
| `GET /api/photos/caption`                | `photoCaptionRequestHandler.ts`                     | `photoCaption/` (Ollama)                                                                                 |
| `GET /api/photos/suggest-rotation`       | `suggestRotationRequestHandler.ts`                  | `imageProcessing/suggestRotation.ts`                                                                     |
| `GET /api/day-photo/…`                   | `dayPhotoRequestHandler.ts`                         | `scripts/dayPhoto/`                                                                                      |
| `GET /api/screensaver`                   | `screensaverRequestHandler.ts`                      | `scripts/dayPhoto/screensaver_pick.py`                                                                   |
| `/api/settings/…`                        | `settingsRequestHandler.ts`                         | `settings` table                                                                                         |
| `/api/auth/…`, `/api/account`            | `authRequestHandler.ts`, `accountRequestHandler.ts` | `auth/`                                                                                                  |
| `GET /share`                             | `sharePreviewRequestHandler.ts`                     | `shareDescription/`                                                                                      |
| `/api/status`, `/api/status/stream`      | `statusRequestHandler.ts`                           | `systemStatus/systemMetrics.ts`, task orchestrator snapshot                                             |
| `GET /api/network-probe`                 | `networkProbeRequestHandler.ts`                     | bytes for the client's bandwidth measurement                                                             |
| `/api/feedback[/:id[/diagnostics]]`      | `feedbackRequestHandler.ts`                         | `feedback` table; saves a diagnostics report per suggestion                                              |
| `/api/diagnostics/events`                | `diagnosticsRequestHandler.ts`                      | `observability/diagnosticsStore.ts`                                                                      |
| `GET /api/diagnostics/perf`, `…/report`  | `diagnosticsReportRequestHandler.ts`                | `observability/perfMonitor.ts`, `systemStatus/buildDiagnosticsReport.ts`                                |

### Serving a file (`files/filesRequestHandler.ts`)

`fileHandler` parses the request and checks access (storage containment, the
share filter). The named representations below go straight to their function;
the rest are tried in turn, and the first that claims the request answers it.
Video ones live in `files/videoRepresentations.ts`, streaming and Range
handling in `files/streamFile.ts`.

| `representation=`                          | Function                            | Produced by                                                                    |
| ------------------------------------------ | ----------------------------------- | ------------------------------------------------------------------------------ |
| `preview` / `webSafe` / `?height=` (image) | `tryImageVariant`                   | `imageProcessing/convertImage.ts` (sharp, Python for HEIC/RAW), cached on disk |
| `micro`                                    | `tryMicroThumbnail`                 | `imageProcessing/microThumbnail.ts` (embedded EXIF thumbnail, else a 160 decode) |
| `preview` (video)                          | `tryVideoThumbnail`                 | `videoProcessing/videoUtils.ts` (ffmpeg frame grab)                            |
| `hls` (+ `variant`, `segment`)             | `tryHLSStream`                      | `videoProcessing/hlsService.ts` `serveHls`; encodes `generateMultibitrateHLS.ts`, lifecycle `hlsSession.ts` |
| `scrub`                                    | `serveScrubFrame`                   | `videoProcessing/videoUtils.ts`, one cached low-res frame per `index`          |
| `storyboard`                               | `serveStoryboard`                   | `videoProcessing/videoStoryboard.ts`                                           |
| `shareMp4`                                 | `serveShareMp4`                     | `videoProcessing/exportShareVideo.ts`                                          |
| `transcript`                               | inline                              | `audioProcessing/processAudioTranscription.ts` output                          |
| `live-photo`                               | `serveLivePhoto`                    | paired `.mov` / embedded motion photo                                          |
| `crop=` (faces)                            | `tryImageCrop`, `tryVideoFrameCrop` | `imageProcessing/convertImage.ts`, `videoProcessing/videoUtils.ts`             |
| none                                       | `streamFile`                        | the original, with range support                                               |

## Video playback, end to end

1. Client opens a video → `client/src/components/viewer/FullscreenViewer.tsx` (the
   "HLS setup effect"). Bandwidth comes from `client/src/videoPlaybackProfile.ts`
   (probed once at app start).
2. `GET /api/video/negotiate` → `videoNegotiation.ts` picks **direct** (link
   can carry the original and the browser can decode it), **live GPU HLS**,
   or **error** (with a reason saying which).
3. HLS: hls.js requests the master → variant playlist → segments from
   `files/videoRepresentations.ts` `tryHLSStream`, which hands each to
   `videoProcessing/hlsService.ts` `serveHls`. Each variant is a separate
   on-demand ffmpeg encode (`generateMultibitrateHLS.ts`) at the source's own
   frame rate up to 30fps (`hlsOutputFrameRate.ts`), queued through the
   task orchestrator (`hlsEncodeQueue.ts`), killed after 8s unused and deleted after 90s
   (`hlsSession.ts`). Segment requests wait for the encoder
   (`hlsSegmentWatcher.ts`).
4. Client ABR: hls.js, with upswitches held back by `client/src/components/viewer/hlsAbrGuard.ts`.
   A stalled direct stream falls back to HLS after 3s.
5. While loading, `VideoLoadingOverlay.tsx` shows the phase, elapsed time and
   when data last arrived. On close, a `video.playback.summary` event records
   startup time, stalls and dropped frames.

## Background pipeline (server)

Wired in `main.ts` → `backgroundTasks/registerBackgroundTasks.ts`, which owns
the arrows below (each stage's `onDrain` queues the stages under it); scheduled
by `taskOrchestrator/` (backs off while a user request is active; see its README).
The face stages are described end to end in `FACES.md`.

```
fileSystemScan ─► fileMetadata (pipeline/processFileInfo.ts)
               ├► exifMetadata (pipeline/processExifMetadata.ts)
               │    ├► placeNames (pipeline/processPlaceNames.ts, places/)
               │    ├► audioTranscription (audioProcessing/, Whisper)
               │    ├► audioEmbedding (audioProcessing/, CLAP)
               │    └► videoFaceAnalysis (videoFaceAnalysis/) ─► faceClustering
               ├► imageAnalysis (imageAnalysis/, faces + CLIP, Python worker)
               │    ├► faceClustering (pipeline/processFaceClustering.ts)
               │    ├► faceAttributes (imageAnalysis/processFaceAttributes.ts)
               │    └► momentClustering (pipeline/processMomentClustering.ts)
               └► thumbnailBackfill (imageProcessing/thumbnailBackfill.ts)
```

File changes after boot: `pipeline/fileSystemMonitorFolder.ts` (watcher)
and `fileSystemRescanRecent.ts` re-queue the entry stages.

## Client

| Concern                         | File(s) in `client/src/`                                          |
| ------------------------------- | ----------------------------------------------------------------- |
| App shell, views, routing state | `App.tsx`, `appNavigation.ts`, `useAppNavigation.ts`, `filterUrlState.ts`, `hooks/useSyncUrlWithFilter.ts` |
| Grid, tiles, hover previews     | `components/grid/` (`ThumbnailGrid.tsx`, `ThumbnailTile.tsx`, `tileMedia/`) |
| Photo/video viewer, editor      | `components/viewer/` (`FullscreenViewer.tsx` and its `useViewer*` hooks, `photoEdit/`) |
| Filters / search                | `components/filter/`, `components/search/`                        |
| People                          | `components/people/`                                              |
| Map                             | `components/map/`                                                 |
| Status, share, account          | `components/status/`, `components/share/`, `components/account/`  |
| API calls                       | `api/*.ts` (all through `api/http.ts` `fetchWithDiagnostics`)     |
| Diagnostics / perf telemetry    | `diagnostics.ts`, `clientPerf.ts`                                 |

## Module boundaries

A module is a directory under `server/src/`, `client/src/` or
`client/src/components/`. Which module may import from which is written down in
each workspace's `eslint.config.mjs` and enforced by `bun run lint`
(`eslint.boundaries.mjs`). A new cross-module import fails until it is either
moved or added to that map on purpose. The server has no known violations left;
the rule still accepts a `grandfathered` list (each entry must match a real
import, so it can only shrink), which the client uses for its backlog.

`server/src/config/` sits below every server module, and any module may import
it. It is the only code that reads `process.env` (lint enforces this): every
variable is parsed and validated once, at startup, into the object `config()`
returns. Child processes get the environment through `config/childEnv.ts`.

## Something is slow or broken

See `DIAGNOSTICS.md`: pull `GET /api/diagnostics/report?clientSessionId=…`
(or the report saved with a suggestion at `/api/feedback/:id/diagnostics`).
