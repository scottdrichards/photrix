# Faces and people

How a face in a photo becomes a named person, and how a person is matched
again later. Each step's detail lives in the file named; this page is the
map. Tables are declared in `server/src/indexDatabase/tables.ts`.

```
detection ─► embedding ─► clustering ─► people (names, merges)
                                │              │
                                └─ verdicts / review ◄─ the user
                                               │
                                   identify ◄──┘ (named centroids)
```

## 1. Detection

The `imageAnalysis` background stage (`imageAnalysis/processImageAnalysis.ts`)
sends each photo to one long-lived Python worker
(`server/python/image_analysis_worker.py`, InsightFace), which decodes it once
for faces and CLIP. Videos get the same treatment from `videoFaceAnalysis/`,
on a handful of sampled frames, collapsed to one face per person per video.

- Boxes are normalised 0..1 against the original image
  (`faceDetection/faceDetector.type.ts`), so they line up with EXIF regions and
  the client's overlay without knowing the resolution.
- Each face row (`faces`) carries the detector's score and the "photo ready"
  attributes (`faceDetection/faceAttributes.ts`); faces found before the
  attributes existed are scored by the `faceAttributes` stage.

## 2. Embeddings

Every face has a recognition vector in `faceEmbeddings`, int8-quantised
(`indexDatabase/embeddingCodec.ts`). It is kept out of `faces` so listing faces
never reads vector bytes.

## 3. Clustering

`indexDatabase/faceClusterEngine.ts` assigns each new face to a cluster as it
is stored, and the `faceClustering` stage (`processFaceClustering.ts`) retries
any that failed.

- Incremental and greedy: a face joins the closest centroid at cosine
  similarity `FACE_CLUSTER_SIMILARITY_THRESHOLD` or above, else seeds a new
  cluster. A cluster (`faceClusters`) is a running-mean centroid; its geometry
  is `faceGeometry.ts`.
- Low-confidence detections (`MIN_FACE_CONFIDENCE_FOR_CLUSTERING`) and
  undecodable vectors get sentinel cluster ids and stay out of People.
- Changing the threshold invalidates every assignment; the engine detects it
  on load and the stage re-clusters.

## 4. People

A person is a root cluster plus the clusters merged into it (`personId`). The
name, tags and per-person similarity floor live on the root row, merges are
logged in `faceClusterMerges`, and the HTTP layer calls a cluster
`person-<n>`. Served by `requestHandlers/peopleRequestHandler.ts`; the client
is `client/src/components/people/`.

## 5. Verdicts and review

Clustering always pulls in some wrong faces, so the user's corrections are
stored and re-applied rather than lost on the next re-cluster.

- `faceVerdicts` holds one `confirmed` or `rejected` verdict per face the user
  ruled on. Confirmed faces (at least `FACE_ANCHOR_MIN_CONFIRMED`) define the
  person's anchor centroid, the reference review distances are measured from.
  `reapplyFaceVerdicts` replays every verdict after a re-cluster.
- `indexDatabase/faceReview.ts` is the pure review logic: `suggestCutoff`
  finds the gap between a person's real faces and the trailing intruders,
  `scoreAnomalies` flags faces that are out of place in time, place or folder,
  and `planOptimization` proposes merges and splits library-wide.
- Applying a cutoff sets the person's similarity floor, so faces below it can't
  rejoin on the next scan.

Verdicts are user work that a rebuild cannot reproduce, which is why schema
changes around them get a real migration (see "Migrations" in
`server/src/indexDatabase/README.md`).

## 6. Identify

`faceDetection/identifyFaces.ts` matches a face from outside the library (a
camera frame, an uploaded snap) against the centroids of **named** people. It
is a different question from clustering ("which of a few dozen known people is
this, if any"), so it has its own thresholds and a margin over the runner-up,
and it never writes to clusters. Served by
`requestHandlers/faceIdentifyRequestHandler.ts` (`/api/faces/…`);
`faceDetection/frigateEventFrames.ts` turns a Frigate NVR event into the
frames worth trying.
