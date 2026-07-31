import type { AsyncSqlite } from "../common/asyncSqlite.ts";
import { getLogger } from "../observability/logger.ts";
import {
  LEGACY_CLIP_ELEMENT_BYTES,
  LEGACY_FACE_ELEMENT_BYTES,
  decodeLegacyEmbedding,
  encodeEmbedding,
} from "./embeddingCodec.ts";
import { ensureTableExists } from "./prepareTables.ts";
import { UNCLUSTERABLE_CLUSTER_ID } from "./faceClusterEngine.ts";

const log = getLogger("migrateEmbeddingStorage");

/**
 * PRAGMA user_version marking that embeddings have been moved out of `files`
 * and `faces` into their side tables and re-encoded as int8.
 */
export const EMBEDDING_STORAGE_VERSION = 5;

/**
 * Rows per batch. Each face row carries a 4 KB legacy BLOB, so 2000 rows is
 * ~8 MB of vector data in flight — small enough to stay well inside the heap
 * cap, large enough that the per-statement overhead doesn't dominate.
 */
const BATCH_SIZE = 2000;

const columnExists = async (
  db: AsyncSqlite,
  table: string,
  column: string,
): Promise<boolean> => {
  const columns = await db.all<{ name: string }>(`PRAGMA table_info(${table})`);
  return columns.some((c) => c.name === column);
};

/**
 * Moves embedding BLOBs out of the `files` and `faces` rows and into the
 * `fileEmbeddings` / `faceEmbeddings` side tables, re-encoding them from their
 * legacy Float64/Float32 form to int8 on the way (see embeddingCodec.ts).
 *
 * Must run *before* prepareTables, which drops the vacated legacy columns.
 *
 * Resumable: it works in batches keyed by primary key and deletes nothing until
 * a batch is committed, so a crash (or an out-of-disk abort) mid-run leaves the
 * database consistent and the next boot picks up where it stopped. It only
 * claims completion — by stamping user_version — once every row is copied.
 *
 * Deliberately does not VACUUM. The win this migration exists for is that
 * `files`/`faces` rows stop carrying vector bytes, which takes effect as soon as
 * the columns are dropped; VACUUM only returns the freed pages to the
 * filesystem, and on a nearly-full disk it is the one step that can fail
 * destructively. Reclaiming the file size is left to `npm run db:vacuum`.
 */
export const migrateEmbeddingStorage = async (db: AsyncSqlite): Promise<void> => {
  const versionRow = await db.get<{ user_version: number }>("PRAGMA user_version");
  if ((versionRow?.user_version ?? 0) >= EMBEDDING_STORAGE_VERSION) return;

  await ensureTableExists(db, "fileEmbeddings");
  await ensureTableExists(db, "faceEmbeddings");

  // A database created after this change never had the legacy columns, so there
  // is nothing to move — just stamp the version.
  const hasLegacyFileColumn = await columnExists(db, "files", "imageEmbedding");
  const hasLegacyFaceColumn = await columnExists(db, "faces", "embedding");

  if (hasLegacyFaceColumn) await migrateFaces(db);
  if (hasLegacyFileColumn) await migrateFiles(db);

  await db.exec(`PRAGMA user_version = ${EMBEDDING_STORAGE_VERSION}`);
  log.info("Embedding storage migration complete");
};

const migrateFaces = async (db: AsyncSqlite): Promise<void> => {
  const total = await db.get<{ count: number }>(
    "SELECT COUNT(*) AS count FROM faces WHERE LENGTH(embedding) > 0",
  );
  if (!total?.count) return;

  log.info({ faces: total.count }, "Moving face embeddings to faceEmbeddings");
  const started = Date.now();
  let lastId = -1;
  let moved = 0;
  let unclusterable = 0;

  for (;;) {
    const rows = await db.all<{ id: number; embedding: Buffer }>(
      `SELECT id, embedding FROM faces
       WHERE id > ? AND LENGTH(embedding) > 0
       ORDER BY id
       LIMIT ?`,
      lastId,
      BATCH_SIZE,
    );
    if (rows.length === 0) break;

    const statements: Array<{ sql: string; params: unknown[] }> = [];
    for (const row of rows) {
      const decoded = decodeLegacyEmbedding(row.embedding, LEGACY_FACE_ELEMENT_BYTES);
      const encoded = decoded && encodeEmbedding(decoded);
      if (encoded) {
        statements.push({
          sql: `INSERT INTO faceEmbeddings (faceId, embedding) VALUES (?, ?)
                ON CONFLICT(faceId) DO UPDATE SET embedding = excluded.embedding`,
          params: [row.id, encoded],
        });
        moved += 1;
      } else {
        // Corrupt or zero-magnitude vector. The sentinel keeps the clustering
        // backfill from re-examining it forever now that its "LENGTH(embedding)
        // > 0" guard no longer exists.
        statements.push({
          sql: "UPDATE faces SET clusterId = ? WHERE id = ? AND clusterId IS NULL",
          params: [UNCLUSTERABLE_CLUSTER_ID, row.id],
        });
        unclusterable += 1;
      }
    }

    await db.transaction(statements);
    lastId = rows[rows.length - 1].id;
    if ((moved + unclusterable) % (BATCH_SIZE * 10) === 0) {
      log.info({ moved, of: total.count }, "Face embedding migration progress");
    }
  }

  // Faces that never had an embedding at all (zero-length BLOB) get the same
  // sentinel, for the same reason.
  const { changes } = await db.run(
    `UPDATE faces SET clusterId = ?
     WHERE clusterId IS NULL
       AND id NOT IN (SELECT faceId FROM faceEmbeddings)`,
    UNCLUSTERABLE_CLUSTER_ID,
  );

  log.info(
    { moved, unclusterable: unclusterable + changes, ms: Date.now() - started },
    "Face embeddings moved",
  );
};

const migrateFiles = async (db: AsyncSqlite): Promise<void> => {
  const total = await db.get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM files
     WHERE imageEmbedding IS NOT NULL OR audioEmbedding IS NOT NULL`,
  );
  if (!total?.count) return;

  log.info({ files: total.count }, "Moving file embeddings to fileEmbeddings");
  const started = Date.now();
  let lastFolder = "";
  let lastFileName = "";
  let moved = 0;

  for (;;) {
    const rows = await db.all<{
      folder: string;
      fileName: string;
      imageEmbedding: Buffer | null;
      audioEmbedding: Buffer | null;
    }>(
      `SELECT folder, fileName, imageEmbedding, audioEmbedding FROM files
       WHERE (imageEmbedding IS NOT NULL OR audioEmbedding IS NOT NULL)
         AND (folder > ? OR (folder = ? AND fileName > ?))
       ORDER BY folder, fileName
       LIMIT ?`,
      lastFolder,
      lastFolder,
      lastFileName,
      BATCH_SIZE,
    );
    if (rows.length === 0) break;

    const statements: Array<{ sql: string; params: unknown[] }> = [];
    for (const row of rows) {
      const image = decodeLegacyEmbedding(row.imageEmbedding, LEGACY_CLIP_ELEMENT_BYTES);
      const audio = decodeLegacyEmbedding(row.audioEmbedding, LEGACY_CLIP_ELEMENT_BYTES);
      const encodedImage = image && encodeEmbedding(image);
      const encodedAudio = audio && encodeEmbedding(audio);
      if (!encodedImage && !encodedAudio) continue;

      statements.push({
        sql: `INSERT INTO fileEmbeddings (folder, fileName, imageEmbedding, audioEmbedding)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(folder, fileName) DO UPDATE SET
                imageEmbedding = excluded.imageEmbedding,
                audioEmbedding = excluded.audioEmbedding`,
        params: [row.folder, row.fileName, encodedImage, encodedAudio],
      });
      moved += 1;
    }

    if (statements.length > 0) await db.transaction(statements);
    lastFolder = rows[rows.length - 1].folder;
    lastFileName = rows[rows.length - 1].fileName;
  }

  log.info({ moved, ms: Date.now() - started }, "File embeddings moved");
};
