import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { EventEmitter } from "node:events";
import type http from "node:http";

afterEach(() => {
  jest.resetModules();
  jest.restoreAllMocks();
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
    getJson: <T = Record<string, unknown>>() => JSON.parse(body || "{}") as T,
  };
};

const makeReq = (url: string, method: string, token: string | null, body?: unknown) => {
  const req = new EventEmitter() as http.IncomingMessage & EventEmitter;
  req.url = url;
  req.method = method;
  req.headers = {
    host: "localhost",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  queueMicrotask(() => {
    if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
  });
  return req;
};

const load = async () => {
  const { accountRequestHandler } = await import("./accountRequestHandler.ts");
  const authService = await import("../auth/authService.ts");
  return { accountRequestHandler, authService };
};

describe("accountRequestHandler", () => {
  it("rejects requests without a login session", async () => {
    const { accountRequestHandler, authService } = await load();
    const apiToken = authService.issueApiToken("alice", "k").token;
    const { res, getStatus } = createJsonResponse();

    // An API token is not an interactive session, so it must be rejected.
    await accountRequestHandler(makeReq("/api/account", "GET", apiToken), res);
    expect(getStatus()).toBe(401);
  });

  it("returns the current username for a session token", async () => {
    const { accountRequestHandler, authService } = await load();
    const token = authService.issueToken("bob");
    const { res, getStatus, getJson } = createJsonResponse();

    await accountRequestHandler(makeReq("/api/account", "GET", token), res);

    expect(getStatus()).toBe(200);
    expect(getJson<{ username: string }>().username).toBe("bob");
    authService.revokeToken(token);
  });

  it("creates, lists (without leaking the raw token), and revokes an MCP key", async () => {
    const { accountRequestHandler, authService } = await load();
    const token = authService.issueToken("carol");

    // Create
    const created = createJsonResponse();
    await accountRequestHandler(
      makeReq("/api/account/mcp-keys", "POST", token, { name: "Claude" }),
      created.res,
    );
    expect(created.getStatus()).toBe(200);
    const key = created.getJson<{ token: string; id: string; name: string }>();
    expect(key.token).toContain("photrix-mcp-v1.");
    expect(key.name).toBe("Claude");
    // The freshly minted key authenticates against Photrix.
    expect(authService.validateToken(key.token)).toBe(true);

    // List — the raw token must not come back, only its id/metadata.
    const listed = createJsonResponse();
    await accountRequestHandler(
      makeReq("/api/account/mcp-keys", "GET", token),
      listed.res,
    );
    const { keys } = listed.getJson<{ keys: Array<{ id: string; token?: string }> }>();
    expect(keys).toHaveLength(1);
    expect(keys[0].id).toBe(key.id);
    expect(keys[0].token).toBeUndefined();

    // Revoke
    const revoked = createJsonResponse();
    await accountRequestHandler(
      makeReq("/api/account/mcp-keys/revoke", "POST", token, { id: key.id }),
      revoked.res,
    );
    expect(revoked.getStatus()).toBe(200);
    expect(authService.validateToken(key.token)).toBe(false);

    authService.revokeToken(token);
  });

  it("does not let a user revoke another user's MCP key", async () => {
    const { accountRequestHandler, authService } = await load();
    const carolToken = authService.issueToken("carol");
    const malloryToken = authService.issueToken("mallory");

    // Carol mints a key and we learn its id from her own list.
    const carolKey = authService.issueApiToken("carol", "secret");
    const carolList = createJsonResponse();
    await accountRequestHandler(
      makeReq("/api/account/mcp-keys", "GET", carolToken),
      carolList.res,
    );
    const carolKeyId = carolList.getJson<{ keys: Array<{ id: string }> }>().keys[0].id;

    // Mallory tries to revoke Carol's key by its real id — it is not in her list,
    // so the handler 404s and Carol's key keeps working.
    const attempt = createJsonResponse();
    await accountRequestHandler(
      makeReq("/api/account/mcp-keys/revoke", "POST", malloryToken, { id: carolKeyId }),
      attempt.res,
    );
    expect(attempt.getStatus()).toBe(404);
    expect(authService.validateToken(carolKey.token)).toBe(true);

    authService.revokeToken(carolToken);
    authService.revokeToken(malloryToken);
    authService.revokeApiToken("carol", carolKey.token);
  });

  it("lists sessions with a current marker and signs out everywhere", async () => {
    const { accountRequestHandler, authService } = await load();
    const t1 = authService.issueToken("dave");
    const t2 = authService.issueToken("dave");

    const listed = createJsonResponse();
    await accountRequestHandler(makeReq("/api/account/sessions", "GET", t1), listed.res);
    const { sessions } = listed.getJson<{
      sessions: Array<{ id: string; current: boolean }>;
    }>();
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((s) => s.current)).toHaveLength(1);

    const out = createJsonResponse();
    await accountRequestHandler(
      makeReq("/api/account/sessions/revoke-all", "POST", t1),
      out.res,
    );
    expect(out.getStatus()).toBe(200);
    expect(authService.validateToken(t1)).toBe(false);
    expect(authService.validateToken(t2)).toBe(false);
  });
});
