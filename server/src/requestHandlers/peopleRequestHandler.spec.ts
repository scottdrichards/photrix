import { describe, expect, it, jest } from "@jest/globals";
import { fakeRequest, recordResponse } from "./handlerTest.fixture.ts";
import { peopleRequestHandler } from "./peopleRequestHandler.ts";

/** Every store method the handler calls, answering "found" unless told otherwise. */
const setup = (overrides: Record<string, unknown> = {}) => {
  const faceClusters = {
    renameCluster: jest.fn(async () => true),
    mergeClusters: jest.fn(async () => undefined),
    getAllPersonTags: jest.fn(async () => ["family"]),
    setClusterTags: jest.fn(async () => true),
    excludeFaceFromCluster: jest.fn(async () => true),
    getFaceClusterReview: jest.fn(async () => ({ faces: [], suggestedCutoff: null })),
    clearFaceClusterRadius: jest.fn(async () => true),
    applyFaceClusterCutoff: jest.fn(async () => ({ affected: 3 })),
    setFaceVerdicts: jest.fn(async () => 2),
    planFaceClusterOptimization: jest.fn(async () => []),
    refitFaceCluster: jest.fn(async () => ({ split: false })),
    shrinkToExcludeFace: jest.fn(async () => ({ excludable: true, collateral: 0 })),
    growToIncludeFace: jest.fn(async () => ({ collateral: [] })),
    assignFaceToPerson: jest.fn(async () => ({ personId: "9" })),
    startClusterForFace: jest.fn(async () => ({ clusterId: "10" })),
    separateCluster: jest.fn(async () => true),
    ...overrides,
  };
  const faces = {
    listNamedPeople: jest.fn(async () => [{ id: "1", name: "Avery" }]),
    getClusterFacePreview: jest.fn(async () => []),
  };
  const call = async (method: string, url: string, body?: unknown) => {
    const recorded = recordResponse();
    await peopleRequestHandler(fakeRequest(method, url, body), recorded.res, {
      faceClusters,
      faces,
    } as never);
    return recorded;
  };
  return { call, faceClusters, faces };
};

const notFound = async () => null;

describe("peopleRequestHandler", () => {
  it.each([
    ["GET", "/api/people/rename"],
    ["POST", "/api/people/named"],
    ["GET", "/api/people/unknown"],
  ])("answers %s %s with 404", async (method, url) => {
    const { call } = setup();
    expect((await call(method, url)).status()).toBe(404);
  });

  it("answers a POST with a body that isn't JSON with 400", async () => {
    const { call, faceClusters } = setup();
    const response = await call("POST", "/api/people/rename", "{not json");
    expect(response.status()).toBe(400);
    expect(response.json()).toEqual({ error: "Invalid JSON" });
    expect(faceClusters.renameCluster).not.toHaveBeenCalled();
  });

  it.each([
    ["/api/people/rename", { name: "Avery" }, "Missing clusterId"],
    ["/api/people/rename", { clusterId: 7 }, "Missing clusterId"],
    ["/api/people/merge", { targetClusterId: "1" }, "Missing targetClusterId or sourceClusterIds"],
    ["/api/people/tags", { clusterId: "1", tags: "family" }, "Missing clusterId or tags"],
    ["/api/people/exclude-face", { faceId: "3" }, "Missing faceId"],
    ["/api/people/cutoff", { threshold: 0.4 }, "Missing clusterId"],
    ["/api/people/cutoff", { clusterId: "1", threshold: "0.4" }, "threshold must be a number or null"],
    ["/api/people/verdict", { faceIds: [], verdict: "confirmed" }, "Missing faceIds"],
    ["/api/people/verdict", { faceIds: ["1"], verdict: "confirmed" }, "Missing faceIds"],
    ["/api/people/verdict", { faceIds: [1], verdict: "maybe" }, "verdict must be confirmed, rejected or null"],
    ["/api/people/refit", {}, "Missing clusterId"],
    ["/api/people/shrink-exclude", { clusterId: "1" }, "Missing clusterId or faceId"],
    ["/api/people/grow-include", { faceId: 1 }, "Missing clusterId or faceId"],
    ["/api/people/assign-face", { name: "Avery" }, "Missing faceId"],
    ["/api/people/assign-face", { faceId: 1 }, "Give personId or a non-empty name"],
    ["/api/people/assign-face", { faceId: 1, name: "   " }, "Give personId or a non-empty name"],
    ["/api/people/new-cluster", { clusterId: "1", faceId: "2" }, "Missing clusterId or faceId"],
    ["/api/people/separate", { clusterId: null }, "Missing clusterId"],
  ])("POST %s with %j is a 400", async (url, body, error) => {
    const { call } = setup();
    const response = await call("POST", url, body);
    expect(response.status()).toBe(400);
    expect(response.json()).toEqual({ error });
  });

  it.each([
    ["/api/people/cluster-preview"],
    ["/api/people/review"],
  ])("GET %s without clusterId is a 400", async (url) => {
    const { call } = setup();
    const response = await call("GET", url);
    expect(response.status()).toBe(400);
    expect(response.json()).toEqual({ error: "Missing clusterId parameter" });
  });

  it.each([
    ["renameCluster", "/api/people/rename", { clusterId: "1", name: "Avery" }, "Cluster not found"],
    ["setClusterTags", "/api/people/tags", { clusterId: "1", tags: [] }, "Cluster not found"],
    ["excludeFaceFromCluster", "/api/people/exclude-face", { faceId: 1 }, "Face not found or not currently clustered"],
    ["clearFaceClusterRadius", "/api/people/cutoff", { clusterId: "1", threshold: null }, "Cluster not found"],
    ["applyFaceClusterCutoff", "/api/people/cutoff", { clusterId: "1", threshold: 0.4 }, "Cluster not found"],
    ["refitFaceCluster", "/api/people/refit", { clusterId: "1" }, "Cluster not found or has no members"],
    ["shrinkToExcludeFace", "/api/people/shrink-exclude", { clusterId: "1", faceId: 2 }, "Cluster or face not found"],
    ["growToIncludeFace", "/api/people/grow-include", { clusterId: "1", faceId: 2 }, "Cluster or face not found"],
    ["assignFaceToPerson", "/api/people/assign-face", { faceId: 1, personId: "4" }, "Face or person not found"],
    ["startClusterForFace", "/api/people/new-cluster", { clusterId: "1", faceId: 2 }, "Cluster or face not found"],
    ["separateCluster", "/api/people/separate", { clusterId: "1" }, "Cluster not found or cannot be separated"],
  ])("answers 404 when %s finds nothing", async (method, url, body, error) => {
    const { call } = setup({ [method]: jest.fn(notFound) });
    const response = await call("POST", url, body);
    expect(response.status()).toBe(404);
    expect(response.json()).toEqual({ error });
  });

  it("answers 404 for the review of an unknown cluster", async () => {
    const { call } = setup({ getFaceClusterReview: jest.fn(notFound) });
    expect((await call("GET", "/api/people/review?clusterId=1")).status()).toBe(404);
  });

  it("renames, clearing the name when none is given", async () => {
    const { call, faceClusters } = setup();
    const response = await call("POST", "/api/people/rename", { clusterId: "5" });
    expect(response.status()).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(faceClusters.renameCluster).toHaveBeenCalledWith("5", null);
  });

  it("merges every source cluster into the target", async () => {
    const { call, faceClusters } = setup();
    const response = await call("POST", "/api/people/merge", {
      targetClusterId: "1",
      sourceClusterIds: ["2", "3"],
    });
    expect(response.status()).toBe(200);
    expect(faceClusters.mergeClusters.mock.calls).toEqual([
      ["2", "1"],
      ["3", "1"],
    ]);
  });

  it("keeps only string tags", async () => {
    const { call, faceClusters } = setup();
    await call("POST", "/api/people/tags", { clusterId: "1", tags: ["family", 3, null, "school"] });
    expect(faceClusters.setClusterTags).toHaveBeenCalledWith("1", ["family", "school"]);
  });

  it("passes cluster-preview's optional numbers only when they parse", async () => {
    const { call, faces } = setup();
    await call("GET", "/api/people/cluster-preview?clusterId=4&limit=3&excludeFaceId=9");
    await call("GET", "/api/people/cluster-preview?clusterId=4&limit=lots");
    expect(faces.getClusterFacePreview.mock.calls).toEqual([
      ["4", { limit: 3, excludeFaceId: 9 }],
      ["4", {}],
    ]);
  });

  it("clears a person's radius for a null threshold", async () => {
    const { call, faceClusters } = setup();
    const response = await call("POST", "/api/people/cutoff", { clusterId: "1", threshold: null });
    expect(response.json()).toEqual({ ok: true, affected: 0 });
    expect(faceClusters.applyFaceClusterCutoff).not.toHaveBeenCalled();
  });

  it("applies a cutoff, as a dry run only when asked", async () => {
    const { call, faceClusters } = setup();
    const response = await call("POST", "/api/people/cutoff", { clusterId: "1", threshold: 0.4, dryRun: "yes" });
    expect(response.json()).toEqual({ ok: true, affected: 3 });
    expect(faceClusters.applyFaceClusterCutoff).toHaveBeenCalledWith("1", 0.4, { dryRun: false });
  });

  it("records verdicts for the numeric face ids only", async () => {
    const { call, faceClusters } = setup();
    const response = await call("POST", "/api/people/verdict", { faceIds: [1, "2", 3], verdict: null });
    expect(response.json()).toEqual({ ok: true, applied: 2 });
    expect(faceClusters.setFaceVerdicts).toHaveBeenCalledWith([1, 3], null);
  });

  it("assigns a face to an existing person before a new name", async () => {
    const { call, faceClusters } = setup();
    await call("POST", "/api/people/assign-face", { faceId: 1, personId: "4", name: "Avery" });
    await call("POST", "/api/people/assign-face", { faceId: 1, name: "Avery" });
    expect(faceClusters.assignFaceToPerson.mock.calls).toEqual([
      [1, { personId: "4" }],
      [1, { name: "Avery" }],
    ]);
  });

  it("grows a cluster with the collateral only when asked", async () => {
    const { call, faceClusters } = setup();
    await call("POST", "/api/people/grow-include", { clusterId: "1", faceId: 2, includeCollateral: true });
    expect(faceClusters.growToIncludeFace).toHaveBeenCalledWith("1", 2, {
      dryRun: false,
      includeCollateral: true,
    });
  });

  it("lists named people, tags and an optimization plan", async () => {
    const { call, faceClusters } = setup();
    expect((await call("GET", "/api/people/named")).json()).toEqual({
      people: [{ id: "1", name: "Avery" }],
    });
    expect((await call("GET", "/api/people/tags")).json()).toEqual({ tags: ["family"] });
    expect((await call("GET", "/api/people/optimize?minWeight=5")).json()).toEqual({ proposals: [] });
    expect(faceClusters.planFaceClusterOptimization).toHaveBeenCalledWith({ minWeight: 5 });
  });
});
