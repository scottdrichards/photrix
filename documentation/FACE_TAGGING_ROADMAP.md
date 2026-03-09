# Face Tagging Roadmap

Date: 2026-03-09
Status: Proposed plan for incremental implementation
Owner: Photrix

Execution checklist: `documentation/FACE_TAGGING_PHASE1_CHECKLIST.md`

## Goals

- Detect faces in photos (videos are out of scope for now).
- Store face regions and identity metadata in the database first.
- Suggest likely person matches for untagged faces.
- Support long time ranges (including children aging) when matching.
- Add a Faces review page to accept/reject suggestions.

## Non-goals (for this roadmap)

- Writing face tags back into image files/XMP.
- Video face extraction and tracking.
- Perfect one-shot identity assignment with no review.

## Core Product Flow

1. Seed embeddings from known-tagged photos (Lightroom/existing regions).
2. Detect and embed faces in untagged photos.
3. Generate suggestions from known exemplars and clustering.
4. Review in a dedicated Faces page (accept/reject/skip).
5. Continuously improve suggestions using user feedback.

## Data Model

Face metadata remains attached to each file record (`files.faceTags` JSON) in v1.

Per-face structure:

- `faceId`: stable identifier for one detected region.
- `dimensions`: normalized `{ x, y, width, height }` in [0..1].
- `embedding`: vector payload (compact JSON array or encoded float32 payload).
- `person`: `{ id, name? } | null`.
- `status`: `"unverified" | "confirmed" | "rejected"`.
- `source`: `"seed-known" | "auto-detected"`.
- `suggestion`:
  - `personId`
  - `confidence`
  - `modelVersion`
  - `suggestedAt`
- `review`:
  - `action`: `"accept" | "reject" | "skip"`
  - `reviewedAt`
  - `reviewer`
- `quality`:
  - `overall`
  - `sharpness`
  - `effectiveResolution`
  - optional pose/occlusion fields (yaw/pitch/roll, occlusion).
- `thumbnail`:
  - `preferredHeight`
  - `cropVersion`
- `detectedAt`

Top-level processing marker:

- `faceMetadataProcessedAt` per file.

## Seed Pass for Known-tagged Images

Before suggesting identities for unknown faces, run a seed pass:

1. Read existing known tags from EXIF/XMP-derived fields (`regions`, `personInImage`).
2. For each labeled face region, compute embedding.
3. Store as `source: "seed-known"` and `status: "confirmed"`.
4. Build person exemplar banks from these confirmed seeds.

This avoids cold start and immediately improves suggestion quality.

## Similarity and Suggestion Strategy

Use cosine similarity on embeddings with the following adjustments:

- Keep multiple exemplars per person (not one centroid).
- Keep time-diverse exemplars to handle aging and appearance change.
- Apply quality-aware weighting (blur/low-res faces require stricter confidence).
- Apply temporal adjustment for large date gaps.
- Persist rejection memory so rejected person suggestions are suppressed unless confidence materially improves.

## Background Processing Pipeline

Add a face processor stage in server background processing:

1. Candidate selection:
  - image files only
  - `faceMetadataProcessedAt IS NULL`
2. Seed known-tagged faces first.
3. Auto-detect faces for remaining images.
4. Compute embeddings.
5. Persist `faceTags` + `faceMetadataProcessedAt`.
6. Generate/update suggestions.

Suggested implementation file:

- `server/src/indexDatabase/processFaceMetadata.ts`

Startup integration target:

- chain after EXIF processing in `server/src/main.ts` (prefer feature flag for first rollout).

## API Plan

Add new endpoints under `/api/faces`.

- `GET /api/faces/queue`
  - paged review queue
  - includes crop URL, source photo path, person suggestion(s), confidence, quality, status
  - filter options: status, min confidence, person, date range, folder
- `POST /api/faces/:faceId/accept`
  - confirm identity (existing person ID or create by name)
- `POST /api/faces/:faceId/reject`
  - reject suggested person
- `GET /api/faces/people`
  - person list + counts

## Client Plan (Faces Page)

Introduce a new Faces review page/view in client:

- Header/view switch: `Library` and `Faces` (routing can be added later if needed).
- Face cards show crop, suggested person, confidence, and quality.
- Actions: Accept, Reject, Skip/Not sure.
- Keyboard shortcuts for review speed.
- Optional filters/sorting:
  - low quality first
  - high confidence first
  - unreviewed only

Likely files:

- `client/src/components/faces/FacesReviewPage.tsx`
- `client/src/api.ts` additions for faces endpoints

## Quality-driven Thumbnail Policy

Use quality metadata to choose crop resolution for browser rendering.

Example policy:

- high quality, sufficiently large face -> smaller transfer (`160-224px`)
- medium quality -> medium crop (`224-320px`)
- low quality or tiny face -> higher crop (`320px+`) to aid human review

Store selected size in `thumbnail.preferredHeight` per face tag.

## Testing Strategy

Server tests:

- seed pass creates confirmed exemplars from known-tagged regions
- auto-detect path populates unverified faces for untagged photos
- suggestion generation honors rejection memory
- queue endpoint pagination and filtering
- accept/reject endpoint behavior and validation

Client tests:

- Faces page renders queue and updates on actions
- Accept/Reject action calls correct API and updates UI state
- sorting/filtering for confidence and quality

## Phased Delivery

Phase 1: Contracts and skeleton

- finalize face tag schema
- add face API contracts and handler skeletons
- add Faces page shell and API client methods
- add tests describing expected behavior

Phase 2: Seed and detect pipeline

- seed known-tagged embeddings
- run detection/embedding on untagged photos
- persist faceTags and processing markers

Phase 3: Suggestion quality

- multi-exemplar matching
- quality and temporal weighting
- rejection memory

Phase 4: UX hardening

- bulk review actions
- confidence tuning tools
- optional write-back planning to photo metadata

## Open Decisions

- Embedding runtime choice:
  - Python worker (recommended for model ecosystem)
  - Node-native integration
- Embedding storage format:
  - JSON float array (easy)
  - binary-encoded float32 (smaller)
- Person identity authority:
  - dedicated people table now vs within faceTags first

## Suggested Defaults

- Start with Python subprocess worker for face detection/embedding.
- Keep v1 storage in `files.faceTags` JSON to ship quickly.
- Defer dedicated person table until review workflow is validated.

## Task Entry Points

When implementing future tasks, use this document as the source roadmap and start from:

- `server/src/indexDatabase/fileRecord.type.ts`
- `server/src/indexDatabase/indexDatabase.ts`
- `server/src/indexDatabase/rowFileRecordConversionFunctions.ts`
- `server/src/main.ts`
- `client/src/api.ts`
- `client/src/App.tsx`
