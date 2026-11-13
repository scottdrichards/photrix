# indexDatabase

SQLite persistence layer for all indexed file metadata, embeddings, and face data.

## Key files

| File                                                                          | What it owns                                                                   |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `openIndexSqlite.ts`                                                          | Opens the one SQLite connection (path, pragmas, SQL functions)                 |
| `indexDatabase.ts`                                                            | `IndexDatabase` class: file queries and mutations, and the stores below        |
| `faceStore.ts`, `faceClusterStore.ts`, `momentStore.ts`, `analysisStore.ts`   | Face, person, moment and analysis-queue queries (`database.faces`, …)          |
| `tables.ts`                                                                   | Schema DDL (`CREATE TABLE`, `CREATE INDEX`)                                    |
| `prepareTables.ts`                                                            | Migration runner — applies DDL at startup                                      |
| `filterToSQL.ts`                                                              | Converts JSON filter trees (from HTTP params) to parameterized WHERE clauses   |
| `processExifMetadata.ts`                                                      | Maps raw EXIF/probe output to DB column values                                 |
| `processFileInfo.ts`                                                          | Extracts file-level facts (size, modified, path)                               |
| `rowFileRecordConversionFunctions.ts`                                         | Converts raw DB rows → typed `FileRecord` objects                              |
| `faceClusterEngine.ts`                                                        | Incremental DBSCAN face clustering against centroid embeddings                 |
| `processFaceClustering.ts`                                                    | Orchestrates clustering passes triggered by the task runner                    |
| `fileSystemScanFolder.ts` / `fileSystemMonitorFolder.ts`                      | FS walk + inotify watcher                                                      |
| `pca.ts`                                                                      | PCA projection for face embedding visualisation                                |

## Who may run SQL

The connection is private to the modules that own tables. `main.ts` opens it
with `openIndexSqlite()` and hands it to `IndexDatabase`, `auth/`,
`featureFlags/` and `feedback/`; each queries only its own tables. Everything
else, request handlers included, calls a method on one of those. To query from
somewhere new, add a method to the store that owns the table.

Every table is declared in `tables.ts`, whichever module owns it.

## Invariants

- **No legacy-compat fallbacks.** Never add conditional logic for old DB schemas. Rebuild the DB instead (see `AGENTS.md`).
- **Request-abort safety.** Long queries called from request handlers must be wrapped with the ALS-based abort signal. Short mutations (≤1 ms) can use `runWithoutRequestAbortSignal`.
- **Sort order.** `queryFiles` ORDER BY must use the `sort_date_v2` composite index to avoid a full-scan filesort. Do not add a plain `ORDER BY dateTaken` without the index.
- **Integer dates.** `dateTaken` is stored as a Unix-ms integer. Guard `typeof dateTaken === 'integer'` before arithmetic; stale TEXT rows from pre-fix ingestion exist in some DBs.
- **Face cluster IDs.** The HTTP layer exposes cluster IDs as `person-<n>`. `filterToSQL.ts` strips the prefix and converts to numeric `clusterId` — pass the raw number to DB queries.
