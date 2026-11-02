import { describe, expect, it } from "@jest/globals";
import { encodeEmbedding } from "../embeddingCodec.ts";
import { FrameVectorSet } from "./frameVectorSet.ts";

const enc = (...values: number[]) => encodeEmbedding(Float32Array.from(values))!;
const QUERY = enc(1, 0, 0);

describe("FrameVectorSet", () => {
  it("returns each video once, at its best frame, best video first", () => {
    const set = new FrameVectorSet();
    set.upsert("/v/", "a.mp4", [
      { timeMs: 0, embedding: enc(0, 1, 0) },
      { timeMs: 5_000, embedding: enc(0.8, 0.6, 0) },
    ]);
    set.upsert("/v/", "b.mp4", [
      { timeMs: 0, embedding: enc(1, 0, 0) },
      { timeMs: 2_000, embedding: enc(0.9, 0.1, 0) },
    ]);
    const hits = set.search(QUERY, 10);
    expect(hits.map((h) => [h.fileName, h.timeMs])).toEqual([
      ["b.mp4", 0],
      ["a.mp4", 5_000],
    ]);
    expect(set.search(QUERY, 1).map((h) => h.fileName)).toEqual(["b.mp4"]);
  });

  it("finds enough videos even when one video's frames crowd the top", () => {
    const set = new FrameVectorSet();
    set.upsert(
      "/v/",
      "busy.mp4",
      Array.from({ length: 50 }, (_, i) => ({ timeMs: i * 1_000, embedding: enc(1, 0.001 * i, 0) })),
    );
    set.upsert("/v/", "quiet.mp4", [{ timeMs: 0, embedding: enc(0.5, 0.5, 0) }]);
    expect(set.search(QUERY, 2).map((h) => h.fileName)).toEqual(["busy.mp4", "quiet.mp4"]);
  });

  it("replaces a video's frames on upsert and drops them on remove", () => {
    const set = new FrameVectorSet();
    set.upsert("/v/", "a.mp4", [{ timeMs: 0, embedding: enc(1, 0, 0) }]);
    set.upsert("/v/", "a.mp4", [{ timeMs: 7_000, embedding: enc(0, 1, 0) }]);
    expect(set.search(QUERY, 5).map((h) => h.timeMs)).toEqual([7_000]);
    set.remove("/v/", "a.mp4");
    expect(set.size).toBe(0);
    expect(set.search(QUERY, 5)).toEqual([]);
  });

  it("moves a video and removes a folder as a whole", () => {
    const set = new FrameVectorSet();
    set.upsert("/v/", "a.mp4", [{ timeMs: 3_000, embedding: enc(1, 0, 0) }]);
    set.upsert("/x/", "b.mp4", [{ timeMs: 0, embedding: enc(1, 0, 0) }]);
    set.move({ folder: "/v/", fileName: "a.mp4" }, { folder: "/w/", fileName: "c.mp4" });
    expect(set.search(QUERY, 5).map((h) => `${h.folder}${h.fileName}@${h.timeMs}`).sort()).toEqual([
      "/w/c.mp4@3000",
      "/x/b.mp4@0",
    ]);
    set.removeFolder("/x/");
    expect(set.search(QUERY, 5).map((h) => h.fileName)).toEqual(["c.mp4"]);
  });

  it("ranks only allowed videos when asked to", () => {
    const set = new FrameVectorSet();
    set.upsert("/v/", "best.mp4", [{ timeMs: 0, embedding: enc(1, 0, 0) }]);
    set.upsert("/v/", "ok.mp4", [{ timeMs: 4_000, embedding: enc(0.5, 0.5, 0) }]);
    expect(set.search(QUERY, 5, [["/v/", "ok.mp4"]]).map((h) => h.fileName)).toEqual(["ok.mp4"]);
  });
});
