# client/src

The React app (Vite, CSS modules). Which file owns which screen is the
"Client" table in `/documentation/ARCHITECTURE.md`; this page is the layout.

| Path | What lives there |
| --- | --- |
| `main.tsx`, `App.tsx` | entry point and app shell: views, URL ↔ filter state (`filterUrlState.ts`) |
| `api/` | every server call. Import from `api/index.ts` (`../api`), the one barrel; requests go through `api/http.ts` `fetchWithDiagnostics` |
| `components/<area>/` | one directory per area (grid, viewer, people, filter, search, map, share, status, account, feedback, selection); shared widgets sit loose in `components/` |
| `hooks/` | hooks used by more than one area |
| `featureFlags/` | `FeatureFlagsContext`, over `shared/feature-flags` |
| loose files in `src/` | foundations every module may import: `auth.ts`, `storage.ts`, `result.ts`, `logFailure.ts`, `diagnostics.ts`, `clientPerf.ts`, `lazyPart.ts`, … |
| `test/setup.ts` | vitest setup (jest-dom matchers) |

- **Module boundaries** are enforced by lint: which directory may import from
  which is the `modules` map in `client/eslint.config.mjs`. A new directory or
  a new cross-module import must be added there.
- **Adding an API call**: write the function in the `api/<area>.ts` file for
  its route, put shared response types in `api/api.type.ts`, export it from
  `api/index.ts`, and add a case to `api.spec.ts`. Put it there rather than
  in a component's own `fetch`, so it gets auth headers and diagnostics.
- The viewer, map and People view load on demand through `lazyPart.ts`; keep
  their imports out of the first screen.
- Types shared with the server (filters, status) come from
  `shared/filter-contract`, not redefined here.
- Tests are vitest: `bun run test` in `client/`. Specs sit beside the file
  (`X.spec.ts[x]`) and mock `../api` rather than `fetch`.
- `vite.config.ts` proxies `/api` to `PHOTRIX_API_TARGET` (default
  `http://localhost:3000`).
