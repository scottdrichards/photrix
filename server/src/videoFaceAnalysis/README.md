# videoFaceAnalysis

Finds people in videos and stores **one face per person per video**, so a
video joins a person's People grid once rather than once per frame.

| File | What it owns |
| --- | --- |
| `processVideoFaceAnalysis.ts` | background stage: reads the queue in batches, extracts frames, runs the shared image-analysis worker, stores faces; stops after `MAX_CONSECUTIVE_FAILURES` in a row |
| `collapseFaceTracks.ts` | groups a video's faces into tracks by similarity and keeps each track's best face |
| `videoFaceCost.ts` | prices each queued video (length, size, resolution) for queue order and the ETA |

- Frames come from `videoProcessing/extractAnalysisFrames.ts`: keyframes for
  short videos, a fixed number of seeks for long ones.
- Detection and embeddings are the same InsightFace path as photos
  (`imageAnalysis/imageAnalysisWorker.ts`), so this stage books the
  `imageAnalysis` budget and never runs alongside it.
- New faces go through normal clustering: the stage's `onDrain` queues
  `faceClustering`. The whole faces pipeline is in
  `/documentation/FACES.md`.
- A video that fails is retried only after a week
  (`AnalysisStore.VIDEO_FACE_RETRY_COOLDOWN_MS` in `indexDatabase/analysisStore.ts`),
  not on every pass.
