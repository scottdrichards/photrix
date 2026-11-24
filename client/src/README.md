# client/src

The React app (Vite, CSS modules). Which file owns which screen is the
"Client" table in `/documentation/ARCHITECTURE.md`; this page is the layout.

| Path | What lives there |
| --- | --- |
| `main.tsx`, `App.tsx` | entry point and app shell: auth gate, theme, layout. `AppHeader.tsx` and `ShareButton.tsx` are its pieces; `appNavigation.ts` (reducer) + `useAppNavigation.ts` hold which tab, which person and which photo is open, in step with the URL (`filterUrlState.ts`) |
| `api/` | every server call. Import from `api/index.ts` (`../api`), the one barrel; requests go through `api/http.ts` `fetchWithDiagnostics` |
| `components/<area>/` | one directory per area (grid, viewer, people, filter, search, map, share, status, account, feedback, selection); shared widgets sit loose in `components/` |
| `hooks/` | hooks used by more than one area |
| `featureFlags/` | `FeatureFlagsContext`, over `@photrix/feature-flags` |
| loose files in `src/` | foundations every module may import: `auth.ts`, `storage.ts`, `result.ts`, `logFailure.ts`, `diagnostics.ts`, `clientPerf.ts`, `lazyPart.ts`, … |
| `test/setup.ts` | vitest setup (jest-dom matchers) |

- **Module boundaries** are enforced by lint: which directory may import from
  which is the `modules` map in `client/eslint.config.mjs`. A new directory or
  a new cross-module import must be added there.
- **Adding an API call**: write the function in the `api/<area>.ts` file for
  its route, export it from `api/index.ts`, and add a case to `api.spec.ts`.
  Put it there rather than in a component's own `fetch`, so it gets auth
  headers and diagnostics. Type the response with the type the server also
  returns, from `@photrix/api-contract` (see below); `api/api.type.ts` holds
  only what the client builds itself (a `PhotoItem`, request options).
- **A new response type**: if the server returns it as JSON, define it once in
  `shared/api-contract/src/index.ts` and import it on both sides. When the
  client reshapes it (a face's `path` becomes a `PhotoItem`), derive the client
  type from the contract one in `api.type.ts` (`Omit<FaceClusterSummary,
  "representative"> & { representative: ClusterFace }`) rather than copying
  the fields, so a server change is a type error here.
- The viewer, map and People view load on demand through `lazyPart.ts`; keep
  their imports out of the first screen.
- Types shared with the server come from the `@photrix/*` workspace packages
  in `shared/` (`filter-contract` for filters and status, `api-contract` for
  responses), not redefined here.
- `components/viewer/FullscreenViewer.tsx` only wires things together. Its
  state lives in hooks beside it (`useViewerNavigation`, `useViewerFaces`,
  `useViewerTranscript`, `useViewerTagging`, `usePhotoEditSession`,
  `usePhotoZoom`, `useViewerChrome`, `useVideoPlayback` for HLS), and its
  larger branches are `ViewerToolbar`, `ViewerVideo` and `EditPreviewFrame`.
- Tests are vitest: `bun run test` in `client/`. Specs sit beside the file
  (`X.spec.ts[x]`) and mock `../api` rather than `fetch`.
- `vite.config.ts` proxies `/api` to `PHOTRIX_API_TARGET` (default
  `http://localhost:3000`).
