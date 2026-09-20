import type { AsyncSqlite } from "../common/asyncSqlite.ts";
import { getLogger } from "../observability/logger.ts";
import { ensureTableExists } from "./prepareTables.ts";

const log = getLogger("migrateFaceVerdicts");

/**
 * Carries the old one-sided `faceExclusions` table into `faceVerdicts`.
 *
 * Every historical exclusion becomes a `rejected` verdict against the cluster
 * it was excluded from, so the corrections the user already made keep working —
 * and, unlike before, now survive a re-cluster (see `reapplyFaceVerdicts`).
 *
 * Runs *before* `prepareTables`, which is what the whole file is shaped around:
 * `faceExclusions` is no longer in the table definitions, so by the time
 * prepareTables has run the source rows would be unreadable. Same ordering
 * constraint, and the same `ensureTableExists` escape hatch, as
 * migrateEmbeddingStorage.
 *
 * Idempotent in two independent ways: it drops the source table when it
 * finishes, and it inserts with `ON CONFLICT DO NOTHING` so a verdict the user
 * has since changed by hand is never overwritten by the legacy row.
 */
export const migrateFaceVerdicts = async (db: AsyncSqlite): Promise<void> => {
  const legacy = await db.get<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'faceExclusions'",
  );
  if (!legacy) return;

  await ensureTableExists(db, "faceVerdicts");

  const rows = await db.all<{ faceId: number; clusterId: number; at: number | null }>(
    `SELECT faceId, excludedFromClusterId AS clusterId, excludedAt AS at
     FROM faceExclusions`,
  );

  if (rows.length) {
    await db.transaction(
      rows.map((row) => ({
        sql: `INSERT INTO faceVerdicts (faceId, personId, verdict, decidedAt)
              VALUES (?, ?, 'rejected', ?)
              ON CONFLICT(faceId) DO NOTHING`,
        params: [row.faceId, row.clusterId, row.at ?? Date.now()],
      })),
    );
  }

  await db.exec("DROP TABLE faceExclusions");
  log.info({ migrated: rows.length }, "Migrated face exclusions into faceVerdicts");
};
