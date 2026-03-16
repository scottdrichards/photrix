import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { IndexDatabase } from "./indexDatabase.ts";
import type { FaceTag } from "./fileRecord.type.ts";

describe("IndexDatabase face queue", () => {
  let storagePath: string;
  let dbPath: string;
  let database: IndexDatabase;

  beforeEach(() => {
    storagePath = mkdtempSync(path.join(os.tmpdir(), "photrix-face-storage-"));
    dbPath = mkdtempSync(path.join(os.tmpdir(), "photrix-face-db-"));
    process.env.INDEX_DB_LOCATION = dbPath;

    database = new IndexDatabase(storagePath);
  });

  afterEach(() => {
    rmSync(storagePath, { recursive: true, force: true });
    delete process.env.INDEX_DB_LOCATION;
  });

  it("returns queue items and supports status/minConfidence filters", async () => {
    const confirmedTag: FaceTag = {
      faceId: "f-confirmed",
      dimensions: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
      featureDescription: { embedding: [0.1, 0.2] },
      person: { id: "name:sam", name: "Sam" },
      status: "confirmed",
      source: "seed-known",
      quality: { overall: 0.9 },
      thumbnail: { preferredHeight: 224 },
    };

    const unverifiedTag: FaceTag = {
      faceId: "f-unverified",
      dimensions: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 },
      featureDescription: { embedding: [0.1, 0.2] },
      person: null,
      status: "unverified",
      source: "auto-detected",
      suggestion: { personId: "name:sam", confidence: 0.87 },
      quality: { overall: 0.7 },
      thumbnail: { preferredHeight: 320 },
    };

    await database.addOrUpdateFileData("/family/a.jpg", {
      faceTags: [confirmedTag, unverifiedTag],
      faceMetadataProcessedAt: new Date().toISOString(),
    });

    const all = database.queryFaceQueue({ page: 1, pageSize: 10 });
    expect(all.total).toBe(2);
    expect(all.items[0]).toMatchObject({
      faceId: "f-unverified",
      status: "unverified",
      source: "auto-detected",
      quality: { overall: 0.7 },
      thumbnail: { preferredHeight: 320 },
    });

    const confirmedOnly = database.queryFaceQueue({ status: "confirmed" });
    expect(confirmedOnly.total).toBe(1);
    expect(confirmedOnly.items[0]?.faceId).toBe("f-confirmed");

    const confidentOnly = database.queryFaceQueue({ minConfidence: 0.8 });
    expect(confidentOnly.total).toBe(1);
    expect(confidentOnly.items[0]?.faceId).toBe("f-unverified");

    const byPerson = database.queryFaceQueue({ personId: "name:sam" });
    expect(byPerson.total).toBe(1);
    expect(byPerson.items[0]?.faceId).toBe("f-confirmed");
  });

  it("filters queue items by path and includeSubfolders", async () => {
    const tag: FaceTag = {
      faceId: "f-family",
      dimensions: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
      featureDescription: { embedding: [0.1, 0.2] },
      person: { id: "name:sam", name: "Sam" },
      status: "confirmed",
      source: "seed-known",
    };

    await database.addOrUpdateFileData("/family/a.jpg", {
      faceTags: [tag],
      faceMetadataProcessedAt: new Date().toISOString(),
    });
    await database.addOrUpdateFileData("/family/sub/b.jpg", {
      faceTags: [{ ...tag, faceId: "f-sub" }],
      faceMetadataProcessedAt: new Date().toISOString(),
    });
    await database.addOrUpdateFileData("/other/c.jpg", {
      faceTags: [{ ...tag, faceId: "f-other" }],
      faceMetadataProcessedAt: new Date().toISOString(),
    });

    const exactOnly = database.queryFaceQueue({ path: "family", includeSubfolders: false });
    expect(exactOnly.total).toBe(1);
    expect(exactOnly.items[0]?.faceId).toBe("f-family");

    const withSubfolders = database.queryFaceQueue({ path: "family", includeSubfolders: true });
    expect(withSubfolders.total).toBe(2);
    const faceIds = withSubfolders.items.map((i) => i.faceId);
    expect(faceIds).toContain("f-family");
    expect(faceIds).toContain("f-sub");
  });

  it("filters people by path", async () => {
    const makeTag = (faceId: string): FaceTag => ({
      faceId,
      dimensions: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
      featureDescription: { embedding: [0.1, 0.2] },
      person: { id: `name:${faceId}` },
      status: "confirmed",
      source: "seed-known",
    });

    await database.addOrUpdateFileData("/family/a.jpg", {
      faceTags: [makeTag("alice")],
      faceMetadataProcessedAt: new Date().toISOString(),
    });
    await database.addOrUpdateFileData("/travel/b.jpg", {
      faceTags: [makeTag("bob")],
      faceMetadataProcessedAt: new Date().toISOString(),
    });

    const familyOnly = database.queryFacePeople({ path: "family", includeSubfolders: false });
    expect(familyOnly.map((p) => p.id)).toEqual(["name:alice"]);

    const all = database.queryFacePeople();
    expect(all.map((p) => p.id)).toContain("name:alice");
    expect(all.map((p) => p.id)).toContain("name:bob");
  });

  it("accepts and rejects suggestions", async () => {
    await database.addOrUpdateFileData("/family/a.jpg", {
      faceTags: [
        {
          faceId: "f-action",
          dimensions: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
          featureDescription: { embedding: [0.1, 0.2] },
          person: null,
          status: "unverified",
          suggestion: { personId: "name:sam", confidence: 0.9 },
        },
      ],
      faceMetadataProcessedAt: new Date().toISOString(),
    });

    const accepted = database.acceptFaceSuggestion({
      faceId: "f-action",
      personId: "name:sam",
      reviewer: "tester",
    });
    expect(accepted).toBe(true);

    const afterAccept = database.queryFaceQueue({ status: "confirmed" });
    expect(afterAccept.total).toBe(1);
    expect(afterAccept.items[0]).toMatchObject({
      faceId: "f-action",
      status: "confirmed",
      person: { id: "name:sam" },
    });

    const rejected = database.rejectFaceSuggestion({
      faceId: "f-action",
      personId: "name:sam",
      reviewer: "tester",
    });
    expect(rejected).toBe(true);

    const afterReject = database.queryFaceQueue({ status: "rejected" });
    expect(afterReject.total).toBe(1);
    expect(afterReject.items[0]).toMatchObject({
      faceId: "f-action",
      status: "rejected",
    });
  });

  it("returns people summary counts with representative face", async () => {
    await database.addOrUpdateFileData("/family/a.jpg", {
      faceTags: [
        {
          faceId: "f1",
          dimensions: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
          featureDescription: { embedding: [0.1, 0.2] },
          person: { id: "name:sam", name: "Sam" },
          status: "confirmed",
          quality: { overall: 0.5, effectiveResolution: 90 },
          thumbnail: { preferredHeight: 320, cropVersion: "v1" },
        },
      ],
      faceMetadataProcessedAt: new Date().toISOString(),
    });

    await database.addOrUpdateFileData("/family/b.jpg", {
      faceTags: [
        {
          faceId: "f2",
          dimensions: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 },
          featureDescription: { embedding: [0.2, 0.3] },
          person: { id: "name:sam" },
          status: "confirmed",
          quality: { overall: 0.9, effectiveResolution: 180 },
          thumbnail: { preferredHeight: 224, cropVersion: "v1" },
        },
      ],
      faceMetadataProcessedAt: new Date().toISOString(),
    });

    const people = database.queryFacePeople();

    expect(people).toEqual([
      {
        id: "name:sam",
        name: "Sam",
        count: 2,
        representativeFace: {
          faceId: "f2",
          relativePath: "/family/b.jpg",
          fileName: "b.jpg",
          dimensions: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 },
          thumbnail: { preferredHeight: 224, cropVersion: "v1" },
        },
      },
    ]);
  });

  it("returns close matches for a selected face", async () => {
    await database.addOrUpdateFileData("/family/a.jpg", {
      faceTags: [
        {
          faceId: "seed-face",
          dimensions: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
          featureDescription: { embedding: [1, 0, 0] },
          person: { id: "name:sam", name: "Sam" },
          status: "confirmed",
        },
      ],
      faceMetadataProcessedAt: new Date().toISOString(),
    });

    await database.addOrUpdateFileData("/family/b.jpg", {
      faceTags: [
        {
          faceId: "match-high",
          dimensions: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 },
          featureDescription: { embedding: [0.99, 0.01, 0] },
          person: { id: "name:sam" },
          status: "unverified",
        },
        {
          faceId: "match-low",
          dimensions: { x: 0.3, y: 0.2, width: 0.2, height: 0.2 },
          featureDescription: { embedding: [0.3, 0.7, 0] },
          person: null,
          status: "unverified",
        },
      ],
      faceMetadataProcessedAt: new Date().toISOString(),
    });

    const matches = database.queryFaceMatches({ faceId: "seed-face", limit: 2 });

    expect(matches).toHaveLength(2);
    expect(matches[0]?.faceId).toBe("match-high");
    expect(matches[0]?.confidence).toBeGreaterThan(matches[1]?.confidence ?? 0);
  });

  it("returns profile-based suggestions from confirmed faces", async () => {
    await database.addOrUpdateFileData("/family/profile1.jpg", {
      faceTags: [
        {
          faceId: "p1",
          dimensions: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
          featureDescription: { embedding: [1, 0, 0] },
          person: { id: "name:sam", name: "Sam" },
          status: "confirmed",
          quality: { overall: 0.9, effectiveResolution: 180 },
        },
      ],
      faceMetadataProcessedAt: new Date().toISOString(),
    });

    await database.addOrUpdateFileData("/family/profile2.jpg", {
      faceTags: [
        {
          faceId: "p2",
          dimensions: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
          featureDescription: { embedding: [0.95, 0.05, 0] },
          person: { id: "name:sam", name: "Sam" },
          status: "confirmed",
          quality: { overall: 0.8, effectiveResolution: 150 },
        },
      ],
      faceMetadataProcessedAt: new Date().toISOString(),
    });

    await database.addOrUpdateFileData("/family/candidates.jpg", {
      faceTags: [
        {
          faceId: "c-high",
          dimensions: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 },
          featureDescription: { embedding: [0.98, 0.02, 0] },
          person: null,
          status: "unverified",
        },
        {
          faceId: "c-low",
          dimensions: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 },
          featureDescription: { embedding: [0.3, 0.7, 0] },
          person: null,
          status: "unverified",
        },
      ],
      faceMetadataProcessedAt: new Date().toISOString(),
    });

    const suggestions = database.queryPersonFaceSuggestions({ personId: "name:sam", limit: 10 });

    expect(suggestions.length).toBeGreaterThanOrEqual(2);
    expect(suggestions[0]?.faceId).toBe("c-high");
    expect((suggestions[0]?.confidence ?? 0)).toBeGreaterThan(
      suggestions[1]?.confidence ?? 0,
    );
  });
});
