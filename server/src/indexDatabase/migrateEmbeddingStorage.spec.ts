import { afterEach, describe, expect, it } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AsyncSqlite } from "../common/asyncSqlite.ts";
import { decodeEmbedding } from "./embeddingCodec.ts";
import { UNCLUSTERABLE_CLUSTER_ID } from "./faceClusterEngine.ts";
import {
  EMBEDDING_STORAGE_VERSION,
  migrateEmbeddingStorage,
} from "./migrateEmbeddingStorage.ts";

const DIM = 128;
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const makeVector = (seed: number): Float64Array => {
  const out = new Float64Array(DIM);
  for (let i = 0; i < DIM; i += 1) out[i] = Math.sin(seed + i) * 0.1;
  return out;
};

const toFloat64Blob = (vector: Float64Array): Buffer => {
  const out = Buffer.allocUnsafe(vector.length * 8);
  vector.forEach((value, i) => out.writeDoubleLE(value, i * 8));
  return out;
};

const toFloat32Blob = (vector: Float64Array): Buffer => {
  const out = Buffer.allocUnsafe(vector.length * 4);
  vector.forEach((value, i) => out.writeFloatLE(value, i * 4));
  return out;
};

const cosine = (a: Float32Array, b: Float64Array): number => {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
};

/** Builds a database shaped like the pre-migration schema. */
const openLegacyDb = async (): Promise<AsyncSqlite> => {
  const dir = mkdtempSync(join(tmpdir(), "photrix-embed-migration-"));
  dirs.push(dir);
  const db = await AsyncSqlite.open(join(dir, "index.db"), {});
  await db.exec(`CREATE TABLE files (
    folder TEXT, fileName TEXT, mimeType TEXT,
    imageEmbedding BLOB, audioEmbedding BLOB,
    embeddingProcessedAt INTEGER, audioEmbeddingProcessedAt INTEGER,
    PRIMARY KEY (folder, fileName))`);
  await db.exec(`CREATE TABLE faces (
    id INTEGER PRIMARY KEY, folder TEXT, fileName TEXT,
    confidence REAL, embedding BLOB, clusterId INTEGER, clusterSimilarity REAL)`);
  return db;
};

describe("migrateEmbeddingStorage", () => {
  it("moves face vectors into faceEmbeddings, preserving direction", async () => {
    const db = await openLegacyDb();
    const original = makeVector(1);
    await db.run(
      "INSERT INTO faces (id, folder, fileName, confidence, embedding) VALUES (?, ?, ?, ?, ?)",
      1,
      "/a",
      "one.jpg",
      0.9,
      toFloat64Blob(original),
    );

    await migrateEmbeddingStorage(db);

    const row = await db.get<{ embedding: Buffer }>(
      "SELECT embedding FROM faceEmbeddings WHERE faceId = 1",
    );
    expect(row).toBeDefined();
    const decoded = decodeEmbedding(row!.embedding)!;
    expect(decoded).not.toBeNull();
    expect(cosine(decoded, original)).toBeGreaterThan(0.999);
    await db.close();
  });

  it("moves image and audio vectors into fileEmbeddings", async () => {
    const db = await openLegacyDb();
    const image = makeVector(2);
    const audio = makeVector(3);
    await db.run(
      "INSERT INTO files (folder, fileName, mimeType, imageEmbedding, audioEmbedding) VALUES (?, ?, ?, ?, ?)",
      "/a",
      "one.jpg",
      "image/jpeg",
      toFloat32Blob(image),
      toFloat32Blob(audio),
    );

    await migrateEmbeddingStorage(db);

    const row = await db.get<{ imageEmbedding: Buffer; audioEmbedding: Buffer }>(
      "SELECT imageEmbedding, audioEmbedding FROM fileEmbeddings WHERE folder = ? AND fileName = ?",
      "/a",
      "one.jpg",
    );
    expect(cosine(decodeEmbedding(row!.imageEmbedding)!, image)).toBeGreaterThan(0.999);
    expect(cosine(decodeEmbedding(row!.audioEmbedding)!, audio)).toBeGreaterThan(0.999);
    await db.close();
  });

  it("stamps faces with no usable vector as unclusterable", async () => {
    const db = await openLegacyDb();
    // Zero-length blob, and a zero-magnitude vector: neither can be normalized.
    await db.run(
      "INSERT INTO faces (id, folder, fileName, confidence, embedding) VALUES (?, ?, ?, ?, ?)",
      1,
      "/a",
      "empty.jpg",
      0.9,
      Buffer.alloc(0),
    );
    await db.run(
      "INSERT INTO faces (id, folder, fileName, confidence, embedding) VALUES (?, ?, ?, ?, ?)",
      2,
      "/a",
      "zero.jpg",
      0.9,
      toFloat64Blob(new Float64Array(DIM)),
    );

    await migrateEmbeddingStorage(db);

    const rows = await db.all<{ id: number; clusterId: number }>(
      "SELECT id, clusterId FROM faces ORDER BY id",
    );
    expect(rows.map((r) => r.clusterId)).toEqual([
      UNCLUSTERABLE_CLUSTER_ID,
      UNCLUSTERABLE_CLUSTER_ID,
    ]);
    const embeddings = await db.all("SELECT faceId FROM faceEmbeddings");
    expect(embeddings).toHaveLength(0);
    await db.close();
  });

  it("leaves an existing cluster assignment alone", async () => {
    const db = await openLegacyDb();
    await db.run(
      "INSERT INTO faces (id, folder, fileName, confidence, embedding, clusterId) VALUES (?, ?, ?, ?, ?, ?)",
      1,
      "/a",
      "assigned.jpg",
      0.9,
      Buffer.alloc(0),
      7,
    );

    await migrateEmbeddingStorage(db);

    const row = await db.get<{ clusterId: number }>(
      "SELECT clusterId FROM faces WHERE id = 1",
    );
    expect(row?.clusterId).toBe(7);
    await db.close();
  });

  it("stamps the version and is a no-op on a second run", async () => {
    const db = await openLegacyDb();
    await db.run(
      "INSERT INTO faces (id, folder, fileName, confidence, embedding) VALUES (?, ?, ?, ?, ?)",
      1,
      "/a",
      "one.jpg",
      0.9,
      toFloat64Blob(makeVector(4)),
    );

    await migrateEmbeddingStorage(db);
    const first = await db.get<{ embedding: Buffer }>(
      "SELECT embedding FROM faceEmbeddings WHERE faceId = 1",
    );
    const version = await db.get<{ user_version: number }>("PRAGMA user_version");
    expect(version?.user_version).toBe(EMBEDDING_STORAGE_VERSION);

    await migrateEmbeddingStorage(db);
    const second = await db.get<{ embedding: Buffer }>(
      "SELECT embedding FROM faceEmbeddings WHERE faceId = 1",
    );
    // Byte-identical: a resumed/repeated run must not re-quantize what it
    // already converted, which would compound rounding error each pass.
    expect(Buffer.compare(first!.embedding, second!.embedding)).toBe(0);
    await db.close();
  });

  it("resumes without duplicating when a previous run was interrupted", async () => {
    const db = await openLegacyDb();
    for (let id = 1; id <= 3; id += 1) {
      await db.run(
        "INSERT INTO faces (id, folder, fileName, confidence, embedding) VALUES (?, ?, ?, ?, ?)",
        id,
        "/a",
        `${id}.jpg`,
        0.9,
        toFloat64Blob(makeVector(id)),
      );
    }
    // Simulate a crash after the first face was copied but before the version
    // was stamped: the table exists and holds a partial result.
    await db.exec(
      "CREATE TABLE IF NOT EXISTS faceEmbeddings (faceId INTEGER, embedding BLOB, PRIMARY KEY (faceId))",
    );
    await db.run(
      "INSERT INTO faceEmbeddings (faceId, embedding) VALUES (?, ?)",
      1,
      Buffer.from([0, 0, 0, 0]),
    );

    await migrateEmbeddingStorage(db);

    const count = await db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM faceEmbeddings",
    );
    expect(count?.count).toBe(3);
    // The partial row was overwritten with a real vector, not left as junk.
    const row = await db.get<{ embedding: Buffer }>(
      "SELECT embedding FROM faceEmbeddings WHERE faceId = 1",
    );
    expect(cosine(decodeEmbedding(row!.embedding)!, makeVector(1))).toBeGreaterThan(
      0.999,
    );
    await db.close();
  });

  it("stamps the version on a fresh database with no legacy columns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "photrix-embed-fresh-"));
    dirs.push(dir);
    const db = await AsyncSqlite.open(join(dir, "index.db"), {});
    await db.exec("CREATE TABLE files (folder TEXT, fileName TEXT)");
    await db.exec("CREATE TABLE faces (id INTEGER PRIMARY KEY, folder TEXT)");

    await migrateEmbeddingStorage(db);

    const version = await db.get<{ user_version: number }>("PRAGMA user_version");
    expect(version?.user_version).toBe(EMBEDDING_STORAGE_VERSION);
    await db.close();
  });
});
