# faceDetection

Face-related logic that sits outside the database: the detector contract,
per-face attributes, and live identification. Detection itself runs in the
Python worker driven by `imageAnalysis/`.

| File | What it owns |
| --- | --- |
| `faceDetector.type.ts` | the detection result shape: boxes normalised 0..1, int8-quantised embeddings |
| `faceAttributes.ts` | "photo ready" attributes (smiling, eyes open, in focus, exposure) and `FACE_ATTRIBUTE_VERSION` |
| `photoQuality.ts` | aggregates per-face attributes into a 0..1 whole-photo score (used to pick a moment's best shot) |
| `identifyFaces.ts` | matches a live face (a camera frame, a phone snap) against named people's centroids |
| `frigateEventFrames.ts` | turns a Frigate NVR event into the frames worth searching for a face |

- Identification is deliberately not clustering: it asks "which known person
  is this" with its own thresholds (`DEFAULT_IDENTIFY_THRESHOLD`,
  `DEFAULT_MIN_MARGIN`) and never writes to clusters.
- Served by `requestHandlers/faceIdentifyRequestHandler.ts` (`/api/faces/…`).
- Bumping `FACE_ATTRIBUTE_VERSION` also needs a reset migration; see
  "Migrations" in `indexDatabase/README.md`.
- The full pipeline, from detection to identify, is
  `/documentation/FACES.md`.
