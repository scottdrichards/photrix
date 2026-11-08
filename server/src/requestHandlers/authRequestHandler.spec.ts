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
      return res;
    }),
    end: jest.fn((chunk?: string) => {
      if (chunk) body += chunk;
      return res;
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
  faces: {
    getFaceClusterNames: () => Promise.resolve(new Map<number, string>()),
  },
} as unknown as import("../indexDatabase/indexDatabase.ts").IndexDatabase;

const loadShareHandler = async () => {
  const { authShareTokenHandler } = await import("./authRequestHandler.ts");
  return authShareTokenHandler;
};

describe("authShareTokenHandler", () => {
  it("stores a stateless live semantic share definition in the token", async () => {
    process.env.PHOTRIX_SHARE_TOKEN_SECRET = "test-share-secret-of-at-least-32-chars";
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
      description: '"sunset beach" · Only favorites, 4 stars or more',
    });

    await authService.revokeToken(authToken);
    if (shareToken) await authService.revokeToken(shareToken);
  });

  it("rejects invalid semantic share source lists", async () => {
    process.env.PHOTRIX_SHARE_TOKEN_SECRET = "test-share-secret-of-at-least-32-chars";
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

    await authService.revokeToken(authToken);
  });

  it("allows live semantic shares without resolving them up front", async () => {
    process.env.PHOTRIX_SHARE_TOKEN_SECRET = "test-share-secret-of-at-least-32-chars";
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

    await authService.revokeToken(authToken);
  });

  it.each([
    ["an empty filter", {}],
    ["a root folder", { folder: { folder: "/", recursive: true } }],
    ["an injected field name", { "1) OR (1": "x" }],
  ])("refuses a share scoped by %s", async (_label, filter) => {
    process.env.PHOTRIX_SHARE_TOKEN_SECRET = "test-share-secret-of-at-least-32-chars";
    const authService = await import("../auth/authService.ts");
    const authToken = authService.issueToken();
    const handler = await loadShareHandler();
    const { res, getStatus, getJson } = createJsonResponse();

    await handler(makeReq(authToken, { filter }), res, fakeDatabase);

    expect(getStatus()).toBe(400);
    expect(getJson().token).toBeUndefined();

    await authService.revokeToken(authToken);
  });

  it("refuses an injected field name on a semantic share", async () => {
    process.env.PHOTRIX_SHARE_TOKEN_SECRET = "test-share-secret-of-at-least-32-chars";
    const authService = await import("../auth/authService.ts");
    const authToken = authService.issueToken();
    const handler = await loadShareHandler();
    const { res, getStatus } = createJsonResponse();

    await handler(
      makeReq(authToken, { filter: { "1) OR (1": "x" }, semanticQuery: "sunset" }),
      res,
      fakeDatabase,
    );

    expect(getStatus()).toBe(400);

    await authService.revokeToken(authToken);
  });

  it("dryRun reports the share size without minting a token", async () => {
    process.env.PHOTRIX_SHARE_TOKEN_SECRET = "test-share-secret-of-at-least-32-chars";
    const authService = await import("../auth/authService.ts");
    const authToken = authService.issueToken();
    const handler = await loadShareHandler();
    const { res, getStatus, getJson } = createJsonResponse();

    const queryFiles = jest.fn(() => Promise.resolve({ items: [], total: 4321 }));
    const database = {
      queryFiles,
      getDefaultExclusionFilter: async () => null,
      faces: {
        getFaceClusterNames: () => Promise.resolve(new Map<number, string>()),
      },
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

// Registration used to take the username from the request body, so any signed-in
// user — or an API key — could add a passkey to another account and sign in as it.
describe("passkey registration", () => {
  const mockPasskeys = () => {
    const generatePasskeyRegistrationOptions = jest.fn(async () => ({ options: {}, sessionId: "s1" }));
    const verifyPasskeyRegistration = jest.fn(async () => true);
    jest.unstable_mockModule("../auth/passkeyService.ts", () => ({
      isPasskeySupported: () => true,
      isPublicOriginConfigured: () => true,
      generatePasskeyRegistrationOptions,
      verifyPasskeyRegistration,
      generatePasskeyAuthenticationOptions: jest.fn(),
      verifyPasskeyAuthentication: jest.fn(),
    }));
    return { generatePasskeyRegistrationOptions, verifyPasskeyRegistration };
  };

  it("registers for the signed-in account, not the one named in the body", async () => {
    const { generatePasskeyRegistrationOptions } = mockPasskeys();
    const { issueToken } = await import("../auth/authService.ts");
    const { passkeyRegistrationOptionsHandler } = await import("./authRequestHandler.ts");
    const { res, getStatus } = createJsonResponse();

    await passkeyRegistrationOptionsHandler(
      makeReq(issueToken("alice"), { username: "admin" }, "/api/auth/passkey/registration-options"),
      res,
    );

    expect(getStatus()).toBe(200);
    expect(generatePasskeyRegistrationOptions).toHaveBeenCalledWith("alice");
  });

  it("refuses an API key, which has no interactive session", async () => {
    const { generatePasskeyRegistrationOptions } = mockPasskeys();
    const { issueApiToken } = await import("../auth/authService.ts");
    const { passkeyRegistrationOptionsHandler } = await import("./authRequestHandler.ts");
    const { res, getStatus } = createJsonResponse();

    await passkeyRegistrationOptionsHandler(
      makeReq(issueApiToken("alice", "mcp").token, {}, "/api/auth/passkey/registration-options"),
      res,
    );

    expect(getStatus()).toBe(403);
    expect(generatePasskeyRegistrationOptions).not.toHaveBeenCalled();
  });

  it("verifies a registration only for the account that started it", async () => {
    const { verifyPasskeyRegistration } = mockPasskeys();
    const { issueToken } = await import("../auth/authService.ts");
    const { passkeyRegistrationVerifyHandler } = await import("./authRequestHandler.ts");
    const { res, getStatus } = createJsonResponse();

    await passkeyRegistrationVerifyHandler(
      makeReq(issueToken("alice"), { sessionId: "s1", response: { id: "x" } }, "/api/auth/passkey/registration-verify"),
      res,
    );

    expect(getStatus()).toBe(200);
    expect(verifyPasskeyRegistration).toHaveBeenCalledWith("s1", { id: "x" }, "alice");
  });
});
