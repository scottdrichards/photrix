# faceDetection

Face-related logic that sits outside the database: the detector contract,
per-face attributes, and live identification. Detection itself runs in the
Python worker driven by `imageAnalysis/`.

| File | What it owns |
| --- | --- |
| `faceDetector.type.ts` | the detection result shape: boxes normalised 0..1, int8-quantised embeddings |
| `faceAttributes.ts` | "photo ready" attributes (smiling, eyes open, in focus, exposure) and `FACE_ATTRIBUTE_VERSION` |
| `photoQuality.ts` | aggregates per-face attributes into a 0..1 whole-photo score (used to pick a moment's best shot) |

`faceIdentify/` is live identification ("who is at the door"), self-contained
so it can move as one piece:

| File | What it owns |
| --- | --- |
| `identifyFaces.ts` | scores a live face (a camera frame, a phone snap) against named people's centroids |
| `identifyFrames.ts` | walks a request's frames (crop, detect, score), stops early on a match; the concurrency slots |
| `frameSource.ts` | turns a request body (bytes, base64, URLs, a Frigate event) into frames, fetched lazily |
| `ssrfGuard.ts` | keeps every frame fetch, and every redirect it follows, on loopback/private addresses |
| `frigateEventFrames.ts` | turns a Frigate NVR event record into the frames worth searching for a face |
| `frameImage.ts` | crops a frame to the caller's box; the size the worker will decode it at |
| `centroidCache.ts` | the one-minute named-centroid cache; people edits drop it |

- Identification is deliberately not clustering: it asks "which known person
  is this" with its own thresholds (`DEFAULT_IDENTIFY_THRESHOLD`,
  `DEFAULT_MIN_MARGIN`) and never writes to clusters.
- Served by `requestHandlers/faceIdentifyRequestHandler.ts` (`/api/faces/…`),
  which only reads the body and maps results to responses. The detector,
  the worker-eviction check and the logger are passed in, so this module
  imports nothing beyond `common/` and `config/`.
- The frame fetcher is the server's one outbound fetch to a caller-chosen
  URL. Only IP literals in private ranges and `localhost` pass; DNS names
  never do. Keep any new fetch behind `ssrfGuard.ts`.
- Bumping `FACE_ATTRIBUTE_VERSION` also needs a reset migration; see
  "Migrations" in `indexDatabase/README.md`.
- The full pipeline, from detection to identify, is
  `/documentation/FACES.md`.
