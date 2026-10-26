import { describe, expect, it } from "@jest/globals";
import { encodeEmbedding } from "../embeddingCodec.ts";
import { VectorSet } from "./vectorSet.ts";

const encode = (vector: number[]) => encodeEmbedding(vector) as Buffer;

// Deterministic pseudo-random vectors (no Math.random, so failures reproduce).
const randomVectors = (count: number, dimension: number, seed: number) => {
  let state = seed;
  const next = () => ((state = (state * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 2 - 1;
  return Array.from({ length: count }, () => Array.from({ length: dimension }, next));
};

// The SQL function this replaces, restated: cosine over the int8 components.
const referenceCosine = (a: Buffer, b: Buffer) => {
  let dot = 0;
  let left = 0;
  let right = 0;
  for (let i = 4; i < a.length; i++) {
    const x = a.readInt8(i);
    const y = b.readInt8(i);
    dot += x * y;
    left += x * x;
    right += y * y;
  }
  return dot / (Math.sqrt(left) * Math.sqrt(right));
};

describe("VectorSet", () => {
  it("ranks exactly as the SQL cosine_similarity_i8 scan did", () => {
    const set = new VectorSet();
    const vectors = randomVectors(3_000, 64, 7).map(encode);
    vectors.forEach((vector, i) => set.upsert("/f/", `${i}.jpg`, vector));
    const query = encode(randomVectors(1, 64, 99)[0]);

    const expected = vectors
      .map((vector, i) => ({ fileName: `${i}.jpg`, similarity: referenceCosine(vector, query) }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 25);
    const actual = set.search(query, 25);

    expect(actual.map((r) => r.fileName)).toEqual(expected.map((r) => r.fileName));
    actual.forEach((r, i) => expect(r.similarity).toBe(expected[i].similarity));
  });

  it("orders and cuts exact ties the same way whatever the limit", () => {
    const set = new VectorSet();
    // Copies of one photo in many folders all score identically.
    for (let i = 0; i < 50; i++) set.upsert(`/copy${i}/`, "same.jpg", encode([1, 0.5]));
    // A better match in a later slot: with a full heap it must evict the *last* tie.
    set.upsert("/best/", "exact.jpg", encode([1, 0]));
    const query = encode([1, 0]);

    const top10 = set.search(query, 10).map((r) => r.folder);

    expect(top10).toEqual(["/best/", ...Array.from({ length: 9 }, (_, i) => `/copy${i}/`)]);
    expect(set.search(query, 30).slice(0, 10).map((r) => r.folder)).toEqual(top10);
  });

  it("returns fewer than the limit when fewer vectors exist", () => {
    const set = new VectorSet();
    set.upsert("/", "a.jpg", encode([1, 0]));
    expect(set.search(encode([1, 0]), 10)).toEqual([{ folder: "/", fileName: "a.jpg", similarity: 1 }]);
  });

  it("replaces a file's vector on upsert rather than adding a second row", () => {
    const set = new VectorSet();
    set.upsert("/", "a.jpg", encode([1, 0]));
    set.upsert("/", "a.jpg", encode([0, 1]));
    expect(set.size).toBe(1);
    expect(set.search(encode([0, 1]), 1)[0].similarity).toBe(1);
  });

  it("forgets removed files and reuses their slot", () => {
    const set = new VectorSet();
    set.upsert("/", "a.jpg", encode([1, 0]));
    set.upsert("/", "b.jpg", encode([0, 1]));
    set.remove("/", "a.jpg");
    expect(set.search(encode([1, 0]), 5).map((r) => r.fileName)).toEqual(["b.jpg"]);
    set.upsert("/", "c.jpg", encode([1, 0]));
    expect(set.size).toBe(2);
    expect(set.search(encode([1, 0]), 1)[0].fileName).toBe("c.jpg");
  });

  it("removes every file under a folder prefix", () => {
    const set = new VectorSet();
    set.upsert("/trip/", "a.jpg", encode([1, 0]));
    set.upsert("/trip/day2/", "b.jpg", encode([1, 0]));
    set.upsert("/home/", "c.jpg", encode([1, 0]));
    set.removeFolder("/trip/");
    expect(set.search(encode([1, 0]), 5).map((r) => r.fileName)).toEqual(["c.jpg"]);
  });

  it("carries a vector across a move, replacing whatever was at the destination", () => {
    const set = new VectorSet();
    set.upsert("/old/", "a.jpg", encode([1, 0]));
    set.upsert("/new/", "a.jpg", encode([0, 1]));
    set.move({ folder: "/old/", fileName: "a.jpg" }, { folder: "/new/", fileName: "a.jpg" });
    expect(set.size).toBe(1);
    expect(set.search(encode([1, 0]), 5)).toEqual([{ folder: "/new/", fileName: "a.jpg", similarity: 1 }]);
  });

  it("ranks only the allowed files when given a list", () => {
    const set = new VectorSet();
    set.upsert("/", "best.jpg", encode([1, 0]));
    set.upsert("/", "worse.jpg", encode([0.5, 0.5]));
    const ranked = set.search(encode([1, 0]), 5, [["/", "worse.jpg"]]);
    expect(ranked.map((r) => r.fileName)).toEqual(["worse.jpg"]);
  });

  it("grows past its initial capacity", () => {
    const set = new VectorSet();
    randomVectors(2_500, 8, 3).forEach((v, i) => set.upsert("/", `${i}.jpg`, encode(v)));
    expect(set.size).toBe(2_500);
    expect(set.search(encode(randomVectors(1, 8, 3)[0]), 1)[0].fileName).toBe("0.jpg");
  });

  it("rejects a vector whose dimension differs from the rest", () => {
    const set = new VectorSet();
    set.upsert("/", "a.jpg", encode([1, 0]));
    expect(() => set.upsert("/", "b.jpg", encode([1, 0, 0]))).toThrow("3 dimensions; this index holds 2");
  });
});
