# Face Tagging Phase 1 Checklist

Date: 2026-03-09
Scope: Phase 1 only (contracts, skeletons, and review page shell)
Reference: `documentation/FACE_TAGGING_ROADMAP.md`

## Phase Goal

Ship an end-to-end vertical slice for face review without final ML quality:

- Face API contracts exist and are test-covered.
- Face metadata schema is codified in TypeScript.
- A basic Faces review page is reachable in the client.
- Accept/Reject actions are wired client to server.

## Definition of Done (Phase 1)

- Server builds and tests pass for new/updated face endpoints.
- Client builds and tests pass for new Faces view and API methods.
- API payloads are stable and documented in code tests.
- No unused imports, dead code, or placeholder mocks left behind unintentionally.

## Milestone 1: Data Contracts

### Task 1.1: Expand face metadata types

Status: Not started

Files:

- `server/src/indexDatabase/fileRecord.type.ts`

Changes:

- Add detailed `FaceTag` shape fields used by roadmap:
  - `faceId`
  - `source`
  - `quality`
  - `thumbnail`
  - `suggestion`
  - `review`
  - `detectedAt`
- Keep backward compatibility where needed (optional fields in Phase 1).

Acceptance criteria:

- TypeScript compiles.
- All existing metadata groups still type-check.
- `faceTags` remains part of `faceMetadata` group.

### Task 1.2: Ensure DB serialization supports contract

Status: Not started

Files:

- `server/src/indexDatabase/rowFileRecordConversionFunctions.ts`

Changes:

- Verify JSON parse/stringify paths for `faceTags` handle expanded structure.
- Add safe guards for malformed JSON if necessary.

Acceptance criteria:

- Round-trip conversion for expanded `faceTags` works.
- Existing rows without new fields still deserialize.

## Milestone 2: Face API Skeleton

### Task 2.1: Add face request handler module

Status: Not started

Files:

- `server/src/requestHandlers/faces/facesRequestHandler.ts` (new)
- `server/src/requestHandlers/faces/facesRequestHandler.spec.ts` (new)
- `server/src/createServer.ts`

Changes:

- Add route entry point for `/api/faces/*`.
- Implement initial handlers:
  - `GET /api/faces/queue`
  - `POST /api/faces/:faceId/accept`
  - `POST /api/faces/:faceId/reject`
  - `GET /api/faces/people`
- Return deterministic placeholder data backed by DB query stubs where full pipeline is not implemented yet.

Acceptance criteria:

- Route dispatch is wired and authenticated like other `/api/*` routes.
- All four endpoints return valid JSON with stable shape.
- Spec tests cover happy path and bad-request cases.

### Task 2.2: Add database query/update surface for face review

Status: Not started

Files:

- `server/src/indexDatabase/indexDatabase.ts`
- `server/src/indexDatabase/indexDatabase.type.ts`
- `server/src/indexDatabase/indexDatabase.spec.ts` (or targeted spec files)

Changes:

- Add database methods for:
  - queue retrieval (paged, basic status filter)
  - accept action (set person/status/review)
  - reject action (set status/review)
  - people summary (name/id/count)
- Keep implementation simple in Phase 1, optimized later.

Acceptance criteria:

- Methods compile and are covered by tests for basic behavior.
- Accept/reject operations are idempotent for repeated calls.

## Milestone 3: Client API + Faces View Shell

### Task 3.1: Add face API client functions

Status: Not started

Files:

- `client/src/api.ts`
- `client/src/api.spec.ts`

Changes:

- Add types and methods:
  - `fetchFaceQueue`
  - `acceptFaceSuggestion`
  - `rejectFaceSuggestion`
  - `fetchFacePeople`
- Use existing fetch conventions (`credentials: include`, URLSearchParams pattern).

Acceptance criteria:

- Tests validate URL construction and payload handling.
- Methods throw clear errors on non-2xx responses.

### Task 3.2: Add Faces page component and basic interactions

Status: Not started

Files:

- `client/src/components/faces/FacesReviewPage.tsx` (new)
- `client/src/components/faces/FacesReviewPage.spec.tsx` (new)
- `client/src/App.tsx`
- `client/src/App.spec.tsx`

Changes:

- Add app-level view switch (`Library` / `Faces`).
- Render a basic queue grid/list of face cards.
- Add Accept/Reject action buttons per card.
- Wire actions to new API methods and local optimistic UI updates.

Acceptance criteria:

- Faces view is reachable from header.
- Accept/Reject triggers API calls with correct arguments.
- App and page tests cover the new view switch and actions.

## Milestone 4: Seed Pass Skeleton (Contract-first)

### Task 4.1: Add processor scaffolding and pipeline hook

Status: Not started

Files:

- `server/src/indexDatabase/processFaceMetadata.ts` (new)
- `server/src/main.ts`
- `server/src/indexDatabase/processFaceMetadata.spec.ts` (new)

Changes:

- Introduce background processor shell with clear stages:
  - seed known-tagged faces
  - detect untagged faces (stubbed in Phase 1)
  - persist `faceTags` and `faceMetadataProcessedAt`
- Wire processor start after EXIF stage, optionally behind env flag.

Acceptance criteria:

- Processor can run without crashing and logs progress.
- Spec verifies stage ordering and that files are marked processed.

## Milestone 5: API Payload Documentation by Test

### Task 5.1: Lock endpoint contract examples in tests

Status: Not started

Files:

- `server/src/requestHandlers/faces/facesRequestHandler.spec.ts`
- `client/src/api.spec.ts`

Changes:

- Add explicit expected payload shapes in assertions.
- Include fields for roadmap-critical data:
  - `quality`
  - `thumbnail.preferredHeight`
  - `source`
  - `status`

Acceptance criteria:

- Contract changes require deliberate test updates.
- Client and server stay aligned on key fields.

## Task Dependencies

1. Milestone 1 before Milestone 2 and Milestone 4.
2. Milestone 2 before Milestone 3 API wiring is fully testable.
3. Milestone 3 can begin in parallel with Milestone 4 scaffolding after API types stabilize.

## Suggested PR Breakdown

PR 1: Types and DB surface

- Task 1.1, 1.2, 2.2 (minimal stubs)

PR 2: Face API handlers

- Task 2.1 + endpoint specs

PR 3: Client Faces view shell

- Task 3.1, 3.2

PR 4: Face processor scaffold

- Task 4.1 + baseline tests

PR 5: Contract hardening

- Task 5.1 and cleanup

## Risks and Mitigations

- Risk: Contract drift between client and server.
  - Mitigation: Contract assertions in both server and client tests.
- Risk: Face metadata shape becomes too broad too early.
  - Mitigation: Keep optional fields in Phase 1 and tighten in Phase 2.
- Risk: Partial implementation leaves dead code.
  - Mitigation: Keep stubs minimal and remove unused paths each PR.

## Implementation Notes for Future Tasks

- Prefer small, test-first increments.
- Keep handlers thin and database operations explicit.
- Reuse existing project patterns for request handlers and API utilities.
- Keep feature flag support in place until queue and review UX are stable.
