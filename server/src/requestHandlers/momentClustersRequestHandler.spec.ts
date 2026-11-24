import { describe, expect, it, jest } from "@jest/globals";
import { fakeRequest, recordResponse } from "./handlerTest.fixture.ts";
import { momentClustersRequestHandler } from "./momentClustersRequestHandler.ts";

const setup = (found = true) => {
  const moments = {
    setMomentClusterRepresentative: jest.fn(async () => found),
    dissolveMomentCluster: jest.fn(async () => found),
  };
  const call = async (method: string, url: string, body?: unknown) => {
    const recorded = recordResponse();
    await momentClustersRequestHandler(fakeRequest(method, url, body), recorded.res, { moments } as never);
    return recorded;
  };
  return { call, moments };
};

describe("momentClustersRequestHandler", () => {
  it("pins a stack's representative", async () => {
    const { call, moments } = setup();
    const response = await call("POST", "/api/moment-clusters/representative", {
      clusterId: "m1",
      path: "/2024/trip/b.jpg",
    });
    expect(response.status()).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(moments.setMomentClusterRepresentative).toHaveBeenCalledWith("m1", "/2024/trip/b.jpg");
  });

  it("dissolves a stack", async () => {
    const { call, moments } = setup();
    expect((await call("POST", "/api/moment-clusters/dissolve", { clusterId: "m1" })).status()).toBe(200);
    expect(moments.dissolveMomentCluster).toHaveBeenCalledWith("m1");
  });

  it.each([
    ["/api/moment-clusters/representative", { clusterId: "m1" }, "Missing clusterId or path"],
    ["/api/moment-clusters/representative", { path: "/a.jpg" }, "Missing clusterId or path"],
    ["/api/moment-clusters/dissolve", { clusterId: 1 }, "Missing clusterId"],
  ])("POST %s with %j is a 400", async (url, body, error) => {
    const { call, moments } = setup();
    const response = await call("POST", url, body);
    expect(response.status()).toBe(400);
    expect(response.json()).toEqual({ error });
    expect(moments.setMomentClusterRepresentative).not.toHaveBeenCalled();
    expect(moments.dissolveMomentCluster).not.toHaveBeenCalled();
  });

  it("answers an empty body with 400", async () => {
    const { call } = setup();
    expect((await call("POST", "/api/moment-clusters/dissolve", "")).json()).toEqual({
      error: "Request body is required",
    });
  });

  it.each([
    ["/api/moment-clusters/representative", { clusterId: "m1", path: "/a.jpg" }, "Cluster or member not found"],
    ["/api/moment-clusters/dissolve", { clusterId: "m1" }, "Cluster not found"],
  ])("answers 404 when %s finds nothing", async (url, body, error) => {
    const { call } = setup(false);
    const response = await call("POST", url, body);
    expect(response.status()).toBe(404);
    expect(response.json()).toEqual({ error });
  });

  it.each([
    ["GET", "/api/moment-clusters/dissolve"],
    ["POST", "/api/moment-clusters/merge"],
  ])("answers %s %s with 404", async (method, url) => {
    const { call } = setup();
    expect((await call(method, url, {})).status()).toBe(404);
  });
});
