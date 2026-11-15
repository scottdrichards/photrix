import { mkdir } from "node:fs/promises";
import path from "node:path";
import { AsyncSqlite } from "../common/asyncSqlite.ts";
import { CACHE_DIR } from "../common/cacheUtils.ts";

export type IndexSqlite = { sqlite: AsyncSqlite; filePath: string };

/**
 * Opens the one SQLite connection the server runs on. The composition root
 * (main.ts) opens it and hands it to each module that owns tables in it: the
 * index (`IndexDatabase`, which also creates every table and closes the
 * connection), auth, feature flags and feedback. Nothing else gets the handle.
 */
export const openIndexSqlite = async (): Promise<IndexSqlite> => {
  const envDbLocation = process.env.INDEX_DB_LOCATION?.trim();
  const databaseDirectory = envDbLocation || CACHE_DIR;
  const filePath = path.join(path.resolve(databaseDirectory), "index.db");

  const directoryPath = path.dirname(filePath);
  const rootPath = path.parse(directoryPath).root;
  if (directoryPath !== rootPath) {
    await mkdir(directoryPath, { recursive: true });
  }

  const sqlite = await AsyncSqlite.open(filePath, {
    pragmas: [
      "journal_mode = WAL",
      "synchronous = NORMAL",
      "wal_autocheckpoint = 1000",
      // Cap the on-disk WAL after a checkpoint. Without this SQLite leaves the
      // WAL at its high-water mark even once frames are written back, so a one-
      // time spike (or a stalled checkpoint) stays on disk forever.
      "journal_size_limit = 67108864",
      // Read through a memory map (one shared copy in the OS page cache, not a
      // private copy per connection) plus a 64 MB page cache per connection.
      // Measured 2026-10-26 on the 3 GB live index: a deep grid page 125 ms →
      // 48 ms, the status aggregate 360 ms → 150 ms; small indexed queries
      // unchanged. 4 GB is address space, sized above the database file.
      // The file must stay on local disk: a mapped read that hits an I/O
      // error kills the process (SIGBUS) instead of failing the query.
      "mmap_size = 4294967296",
      "cache_size = -65536",
    ],
    // Every query the app serves runs on a read connection, so the memory map
    // has to be set there too; it was only ever set on the writer. Measured
    // 2026-11-12 on the 3 GB live index: the grid's count 493 ms -> 312 ms. A
    // larger page cache on top of the map measured no different, so the
    // readers keep the default.
    readPragmas: ["mmap_size = 4294967296"],
    customFunctions: [
      { name: "REGEXP", options: { deterministic: true }, type: "regexp" },
      {
        // Similarity over int8 embedding blobs (see embeddingCodec.ts), for
        // queries that compare against a subset of vectors inside SQL.
        name: "cosine_similarity_i8",
        options: { deterministic: true },
        type: "cosine_similarity_i8",
      },
    ],
  });
  return { sqlite, filePath };
};
