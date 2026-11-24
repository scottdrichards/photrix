# indexDatabase

SQLite persistence layer for all indexed file metadata, embeddings, and face data.

## Key files

| File                                                                          | What it owns                                                                   |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `openIndexSqlite.ts`                                                          | Opens the one SQLite connection (path, pragmas, SQL functions)                 |
| `indexDatabase.ts`                                                            | `IndexDatabase` class: file queries and mutations, and the stores below        |
| `faceStore.ts`, `faceClusterStore.ts`, `momentStore.ts`, `analysisStore.ts`   | Face, person, moment and analysis-queue queries (`database.faces`, …)          |
| `tables.ts`                                                                   | Schema DDL (`CREATE TABLE`, `CREATE INDEX`)                                    |
| `prepareTables.ts`                                                            | Reconciles the live schema with `tables.ts` at startup (adds, drops, indexes)  |
| `migrate*.ts`                                                                 | Data migrations that must run before `prepareTables` (see Migrations)          |
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

## Migrations

Production databases hold work a user did by hand (named people, face
verdicts, merges, ratings), so a schema change must carry that data forward.
Rebuilding is fine for anything derived (embeddings, EXIF, clusters a
re-run can reproduce); it is not fine for user judgements.

- **Additive schema changes need no code.** Add the column or table to
  `tables.ts`. `prepareTables` creates what is missing and drops columns that
  are no longer listed, so a removed column's data is gone after the next boot.
- **Moving data out of something you are removing** gets its own
  `migrate<What>.ts` in this directory, called from `IndexDatabase.init()`
  *before* `prepareTables` (which would otherwise drop the source first). It
  creates its destination with `ensureTableExists`, copies, then drops or
  stops reading the source. Examples: `migrateEmbeddingStorage.ts`,
  `migrateFaceVerdicts.ts`.
- **Re-queuing or rewriting existing rows once** (a backfill) is a method on
  the store that owns the table, gated by `PRAGMA user_version` with a named
  `*_VERSION` constant next to it (`TAGS_BACKFILL_VERSION`,
  `FACE_ATTRIBUTE_RESET_VERSION`, …). All of them share the one
  `user_version` counter, so a new one takes the next unused number (highest
  today: 6, `TAGS_BACKFILL_VERSION`) and runs only when the stored version is
  below it. Search for `_VERSION = ` before picking one.
- **Every migration is idempotent and resumable.** Check before acting (does
  the legacy table or column still exist? is the version already stamped?),
  stamp the version or drop the source only after the work committed, and use
  `ON CONFLICT DO NOTHING` so a value the user has since changed wins.
- **Test it** against a temp database: build the legacy shape with raw SQL,
  run the migration, assert on the migrated rows, then run it again to prove
  it is a no-op (see `migrateEmbeddingStorage.spec.ts`).
- Remove a migration once every database that matters has run it, together
  with the legacy shape it reads. Don't add read-time fallbacks for old shapes:
  migrate once at startup instead.

## Invariants

- **Request-abort safety.** Long queries called from request handlers must be wrapped with the ALS-based abort signal. Short mutations (≤1 ms) can use `runWithoutRequestAbortSignal`.
- **Sort order.** `queryFiles` ORDER BY must use the `sort_date_v2` composite index to avoid a full-scan filesort. Do not add a plain `ORDER BY dateTaken` without the index.
- **Integer dates.** `dateTaken` is stored as a Unix-ms integer. Guard with `Number.isInteger(dateTaken)` before arithmetic; stale TEXT rows from pre-fix ingestion exist in some DBs.
- **Face cluster IDs.** The HTTP layer exposes cluster IDs as `person-<n>`. `filterToSQL.ts` strips the prefix and converts to numeric `clusterId` — pass the raw number to DB queries.
