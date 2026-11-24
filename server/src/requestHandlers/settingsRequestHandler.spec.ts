import { describe, expect, it, jest } from "@jest/globals";
import { fakeRequest, recordResponse } from "./handlerTest.fixture.ts";
import { settingsRequestHandler } from "./settingsRequestHandler.ts";

const exclusion = { operation: "and", conditions: [{ personId: { $eq: "3" } }] };

const setup = (stored: unknown = null) => {
  const database = {
    getDefaultExclusionFilter: jest.fn(async () => stored),
    setDefaultExclusionFilter: jest.fn(async () => undefined),
  };
  const call = async (method: string, url: string, body?: unknown) => {
    const recorded = recordResponse();
    await settingsRequestHandler(fakeRequest(method, url, body), recorded.res, database as never);
    return recorded;
  };
  return { call, database };
};

const route = "/api/settings/default-exclusion";

describe("settingsRequestHandler", () => {
  it("reads the default exclusion", async () => {
    const { call } = setup(exclusion);
    const response = await call("GET", route);
    expect(response.status()).toBe(200);
    expect(response.json()).toEqual({ filter: exclusion });
  });

  it("stores a new default exclusion", async () => {
    const { call, database } = setup();
    const response = await call("POST", route, { filter: exclusion });
    expect(response.status()).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(database.setDefaultExclusionFilter).toHaveBeenCalledWith(exclusion);
  });

  it.each([
    ["an empty body", ""],
    ["a null filter", { filter: null }],
    ["no filter", {}],
  ])("clears it for %s", async (_label, body) => {
    const { call, database } = setup(exclusion);
    expect((await call("POST", route, body)).status()).toBe(200);
    expect(database.setDefaultExclusionFilter).toHaveBeenCalledWith(null);
  });

  it("answers a body that isn't JSON with 400 and stores nothing", async () => {
    const { call, database } = setup();
    const response = await call("POST", route, "{filter:");
    expect(response.status()).toBe(400);
    expect(database.setDefaultExclusionFilter).not.toHaveBeenCalled();
  });

  it.each([
    ["PUT", route],
    ["GET", "/api/settings/other"],
  ])("answers %s %s with 404", async (method, url) => {
    const { call } = setup();
    expect((await call(method, url)).status()).toBe(404);
  });
});
