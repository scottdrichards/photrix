// Compacts the index database, returning pages freed by the embedding storage
// migration to the filesystem.
//
// Kept out of server startup on purpose. Dropping the embedding columns is what
// makes `files`/`faces` rows cheap to scan, and that takes effect immediately;
// VACUUM only shrinks the file. It also rewrites the whole database into a temp
// copy, so on a nearly-full disk it is the one step that can fail badly — better
// as a deliberate, checked operation than something that runs on every boot.
//
// Usage: npm run db:vacuum
import Database from "better-sqlite3";
import { statSync } from "node:fs";
import { statfsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import "dotenv/config";

const cacheDir = process.env.CACHE_DIR || "./.cache";
const dbPath = resolve(process.cwd(), cacheDir, "index.db");

const sizeBytes = statSync(dbPath).size;
const { bavail, bsize } = statfsSync(dirname(dbPath));
const freeBytes = bavail * bsize;

const mb = (bytes) => `${(bytes / 1048576).toFixed(0)} MB`;
console.log(`database: ${mb(sizeBytes)}`);
console.log(`free disk: ${mb(freeBytes)}`);

// VACUUM builds the compacted copy alongside the original before swapping, so
// the peak requirement is the *new* size — unknown up front, but bounded by the
// current one. Require that much plus a margin rather than risk a partial write.
const required = sizeBytes * 1.1;
if (freeBytes < required) {
  console.error(
    `\nRefusing to VACUUM: need ~${mb(required)} free, have ${mb(freeBytes)}.` +
      `\nFree some space and re-run, or leave it — the freed pages are still` +
      `\nreused by future writes, only the file size stays large.`,
  );
  process.exit(1);
}

console.log("\nVACUUM… (the server should be stopped)");
const started = Date.now();
const db = new Database(dbPath);
db.exec("VACUUM");
db.close();

const after = statSync(dbPath).size;
console.log(
  `done in ${((Date.now() - started) / 1000).toFixed(1)}s: ` +
    `${mb(sizeBytes)} -> ${mb(after)} (freed ${mb(sizeBytes - after)})`,
);
