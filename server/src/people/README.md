# people

Faces once they are in the index: stored face rows, clusters and the people
built from them, the user's corrections, and live identification. The end to
end story, detection to identify, is `/documentation/FACES.md`.

## The boundary with the producers

`people/` consumes faces; it does not find them.

- `faceDetection/` is the contract the producers share: the detection result
  shape (`faceDetector.type.ts`), per-face attributes, the photo-quality score.
  It imports nothing from `people/`.
- `imageAnalysis/` (photos) and `videoFaceAnalysis/` (sampled video frames)
  run the detector and hand each result to `database.faces`
  (`store/faceStore.ts`), which stores the rows and clusters each new face as
  it lands. They never touch clusters directly.
- Everything after that, clusters, names, merges, verdicts, the People tab
  and identify, is here.

`indexDatabase/` and `people/` import each other at one seam:
`IndexDatabase` builds the face stores onto `database.faces` and
`database.faceClusters`, and `people/` reads the index's plumbing
(`filterToSQL`, row types, the embedding codec). Tables, face ones included,
are declared in `indexDatabase/tables.ts`.

## Layout

| Directory | What it holds |
| --- | --- |
| `store/` | everything that runs SQL against face tables |
| `clustering/` | pure math over faces and clusters: cap geometry, PCA, the People layout, the video share of a capped list |
| `review/` | pure review logic: the cut line, anomaly flags, the library-wide optimiser |
| `identify/` | live identification ("who is at the door"), self-contained |

### store/

| File | What it owns |
| --- | --- |
| `faceStore.ts` | `database.faces`: face rows, embeddings, attributes, video faces |
| `faceClusterEngine.ts` | the in-memory cluster index (centroids, caps, anchors) and its writes to `faceClusters` |
| `faceClusterStore.ts` | `database.faceClusters`: a facade forwarding to the five stores below |
| `faceClusterLayout.ts` | the People-tab 3D layout, merge suggestions, and the caches every write invalidates |
| `peopleQueries.ts` | the People list, a person's page, tags, named centroids, clustering progress |
| `personDetail.ts` | the named steps of a person's page: scope, faces, video share, Match Groups |
| `faceClusterEdits.ts` | draining the clustering backlog, one-time repairs, rename, merge, separate, tags |
| `faceClusterReviewStore.ts` | the review list, verdicts, applying a cut line, the optimiser's plan |
| `faceClusterCaps.ts` | refit, shrink, grow, start a cluster, assign a face to a person |
| `migrateFaceVerdicts.ts` | the startup migration that carried verdicts into `faceVerdicts` |
| `faceClusterId.ts`, `faceRowToClusterFace.ts`, `deleteFacesStatements.ts` | `person-<n>` ids, row shaping, the face-delete statements file deletes share |

### clustering/, review/

| File | What it owns |
| --- | --- |
| `clustering/faceGeometry.ts` | a cluster as a cap (centre and distance): fit, grow, shrink, collateral |
| `clustering/pca.ts` | 3D PCA of cluster centroids |
| `clustering/clusterLayout.ts` | the People layout's pure steps: PCA points, centroid normalisation, year labels |
| `clustering/clusterDetailVideoShare.ts` | how many video faces a capped person page must show |
| `review/faceReview.ts` | `suggestCutoff`, `scoreAnomalies`, `planOptimization` |

### identify/

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
  the worker-eviction check and the logger are passed in, so `identify/`
  imports only `common/`, `config/` and the detector type from
  `faceDetection/`.
- The frame fetcher is the server's one outbound fetch to a caller-chosen
  URL. Only IP literals in private ranges and `localhost` pass; DNS names
  never do. Keep any new fetch behind `ssrfGuard.ts`.

## Rules

- `clustering/` and `review/` run no SQL and hold no state; test them as
  plain functions. A new query goes on the store in `store/` that owns the
  table.
- Any write that changes faces, clusters, names or merges calls
  `invalidateFaceClusterPCACache`, or the layout and suggestions go stale.
- Verdicts, names and merges are user work: carry them across a schema change
  with a migration (see "Migrations" in `indexDatabase/README.md`).
