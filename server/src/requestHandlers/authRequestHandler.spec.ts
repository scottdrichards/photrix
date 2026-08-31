import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { EventEmitter } from "node:events";
import type http from "node:http";

afterEach(() => {
  jest.resetModules();
  jest.restoreAllMocks();
  delete process.env.PHOTRIX_SHARE_TOKEN_SECRET;
});

const createJsonResponse = () => {
  let status = 0;
  let body = "";
  const res = {
    writeHead: jest.fn((code: number) => {
      status = code;
      return res as unknown as http.ServerResponse;
    }),
    end: jest.fn((chunk?: string) => {
      if (chunk) body += chunk;
      return res as unknown as http.ServerResponse;
    }),
  } as unknown as http.ServerResponse;
  return {
    res,
    getStatus: () => status,
    getJson: () => JSON.parse(body) as { token?: string; count?: number },
  };
};

const makeReq = (token: string, body: unknown, url = "/api/auth/share-token") => {
  const req = new EventEmitter() as http.IncomingMessage & EventEmitter;
  req.url = url;
  req.headers = {
    host: "localhost",
    authorization: `Bearer ${token}`,
  };

  queueMicrotask(() => {
    req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
  });

  return req;
};

// Share titling only reaches the database to resolve face-cluster names, which
// none of these filters use.
const fakeDatabase = {
  getFaceClusterNames: () => Promise.resolve(new Map<number, string>()),
} as unknown as import("../indexDatabase/indexDatabase.ts").IndexDatabase;

const loadShareHandler = async () => {
  const { authShareTokenHandler } = await import("./authRequestHandler.ts");
  return authShareTokenHandler;
};

describe("authShareTokenHandler", () => {
  it("stores a stateless live semantic share definition in the token", async () => {
    process.env.PHOTRIX_SHARE_TOKEN_SECRET = "test-share-secret";
    const authService = await import("../auth/authService.ts");
    const authToken = authService.issueToken();
    const handler = await loadShareHandler();
    const { res, getStatus, getJson } = createJsonResponse();

    await handler(
      makeReq(authToken, {
        filter: { rating: { min: 4 } },
        semanticQuery: "sunset beach",
        searchSources: ["image"],
      }),
      res,
      fakeDatabase,
    );

    expect(getStatus()).toBe(200);
    const shareToken = getJson().token;
    expect(shareToken).toBeDefined();
    expect(authService.getShareScope(shareToken ?? "")).toEqual({
      filter: {
        rating: { min: 4 },
      },
      semanticQuery: "sunset beach",
      searchSources: ["image"],
      // No PHOTRIX_OLLAMA_URL in tests, so the deterministic facet summary
      // stands in for the generated title.
      description:
        'Photos matching the search "sunset beach" · Only favorites, 4 stars or more',
    });

    authService.revokeToken(authToken);
    if (shareToken) authService.revokeToken(shareToken);
  });

  it("rejects invalid semantic share source lists", async () => {
    process.env.PHOTRIX_SHARE_TOKEN_SECRET = "test-share-secret";
    const authService = await import("../auth/authService.ts");
    const authToken = authService.issueToken();
    const handler = await loadShareHandler();
    const { res, getStatus } = createJsonResponse();

    await handler(
      makeReq(authToken, {
        filter: {},
        semanticQuery: "sunset beach",
        searchSources: ["bogus"],
      }),
      res,
      fakeDatabase,
    );

    expect(getStatus()).toBe(400);

    authService.revokeToken(authToken);
  });

  it("allows live semantic shares without resolving them up front", async () => {
    process.env.PHOTRIX_SHARE_TOKEN_SECRET = "test-share-secret";
    const authService = await import("../auth/authService.ts");
    const authToken = authService.issueToken();
    const handler = await loadShareHandler();
    const { res, getStatus, getJson } = createJsonResponse();

    await handler(
      makeReq(authToken, {
        filter: {},
        semanticQuery: "sunset beach",
        searchSources: ["image"],
      }),
      res,
      fakeDatabase,
    );

    expect(getStatus()).toBe(200);
    expect(getJson().token).toBeDefined();

    authService.revokeToken(authToken);
  });

  it("dryRun reports the share size without minting a token", async () => {
    process.env.PHOTRIX_SHARE_TOKEN_SECRET = "test-share-secret";
    const authService = await import("../auth/authService.ts");
    const authToken = authService.issueToken();
    const handler = await loadShareHandler();
    const { res, getStatus, getJson } = createJsonResponse();

    const queryFiles = jest.fn(() => Promise.resolve({ items: [], total: 4321 }));
    const database = {
      getFaceClusterNames: () => Promise.resolve(new Map<number, string>()),
      queryFiles,
    } as unknown as import("../indexDatabase/indexDatabase.ts").IndexDatabase;

    await handler(
      makeReq(
        authToken,
        { filter: { rating: { min: 4 } } },
        "/api/auth/share-token?dryRun=1",
      ),
      res,
      database,
    );

    expect(getStatus()).toBe(200);
    expect(getJson().count).toBe(4321);
    // A preflight must not leave a usable link behind.
    expect(getJson().token).toBeUndefined();
    expect(queryFiles).toHaveBeenCalled();
  });
});
