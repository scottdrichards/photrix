# faceDetection

Face-related logic that sits outside the database: the detector contract
and per-face attributes. Detection itself runs in the
Python worker driven by `imageAnalysis/`.

| File | What it owns |
| --- | --- |
| `faceDetector.type.ts` | the detection result shape: boxes normalised 0..1, int8-quantised embeddings |
| `faceAttributes.ts` | "photo ready" attributes (smiling, eyes open, in focus, exposure) and `FACE_ATTRIBUTE_VERSION` |
| `photoQuality.ts` | aggregates per-face attributes into a 0..1 whole-photo score (used to pick a moment's best shot) |

- This module is the producers' shared contract. `imageAnalysis/` and
  `videoFaceAnalysis/` run the detector and store faces through
  `database.faces`; everything after that, clusters, people, review and live
  identification, is `people/` (see its README).
- Bumping `FACE_ATTRIBUTE_VERSION` also needs a reset migration; see
  "Migrations" in `indexDatabase/README.md`.
- The full pipeline, from detection to identify, is
  `/documentation/FACES.md`.
