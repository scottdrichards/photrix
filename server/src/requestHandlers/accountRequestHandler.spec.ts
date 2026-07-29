import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { EventEmitter } from "node:events";
import type http from "node:http";
import Database from "better-sqlite3";
import type { AsyncSqlite } from "../common/asyncSqlite.ts";

// A minimal stand-in for AsyncSqlite backed by a real in-memory sqlite db, just
// enough of the surface (all/run/get with the "sql, ...params" calling
// convention used throughout authService.ts) to exercise real SQL — needed for
// listShareLinks, whose revoked-link filtering lives in the query itself.
const makeTestDb = (): AsyncSqlite => {
  const raw = new Database(":memory:");
  raw.exec(
    "CREATE TABLE share_links (token TEXT PRIMARY KEY, username TEXT, label TEXT, createdAt INTEGER, revokedAt INTEGER)",
  );
  raw.exec(
    "CREATE TABLE auth_sessions (token TEXT PRIMARY KEY, username TEXT, createdAt INTEGER, ip TEXT, lastSeenAt INTEGER)",
  );
  raw.exec(
    "CREATE TABLE api_tokens (token TEXT PRIMARY KEY, username TEXT, name TEXT, createdAt INTEGER, lastUsedAt INTEGER)",
  );
  return {
    all: async (sql: string, ...params: unknown[]) => raw.prepare(sql).all(...params),
    run: async (sql: string, ...params: unknown[]) => raw.prepare(sql).run(...params),
    get: async (sql: string, ...params: unknown[]) => raw.prepare(sql).get(...params),
    exec: async (sql: string) => {
      raw.exec(sql);
    },
  } as unknown as AsyncSqlite;
};

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

  it("includes a coarse IP/location classification per session", async () => {
    const { accountRequestHandler, authService } = await load();
    const local = authService.issueToken("erin", "192.168.1.42");
    const remote = authService.issueToken("erin", "203.0.113.7");

    const listed = createJsonResponse();
    await accountRequestHandler(makeReq("/api/account/sessions", "GET", local), listed.res);
    const { sessions } = listed.getJson<{
      sessions: Array<{ ip: string | null; location: string }>;
    }>();
    expect(sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ip: "192.168.1.42", location: "Local network" }),
        expect.objectContaining({ ip: "203.0.113.7", location: "Internet" }),
      ]),
    );

    authService.revokeToken(local);
    authService.revokeToken(remote);
  });

  it("revokes every other session but keeps the caller signed in", async () => {
    const { accountRequestHandler, authService } = await load();
    const keep = authService.issueToken("frank");
    const other1 = authService.issueToken("frank");
    const other2 = authService.issueToken("frank");

    const res = createJsonResponse();
    await accountRequestHandler(
      makeReq("/api/account/sessions/revoke-others", "POST", keep),
      res.res,
    );

    expect(res.getStatus()).toBe(200);
    expect(authService.validateToken(keep)).toBe(true);
    expect(authService.validateToken(other1)).toBe(false);
    expect(authService.validateToken(other2)).toBe(false);

    authService.revokeToken(keep);
  });

  it("hides revoked share links from the list", async () => {
    const { accountRequestHandler, authService } = await load();
    await authService.initAuthService(makeTestDb());
    const token = authService.issueToken("grace");
    authService.recordShareLink("grace", "photrix-share-v1.one", "Trip A");
    authService.recordShareLink("grace", "photrix-share-v1.two", "Trip B");
    // Give the fire-and-forget INSERTs a tick to land before revoking/listing.
    await new Promise((r) => setTimeout(r, 0));
    await authService.revokeShareLink("grace", "photrix-share-v1.one");

    const listed = createJsonResponse();
    await accountRequestHandler(
      makeReq("/api/account/share-links", "GET", token),
      listed.res,
    );
    const { links } = listed.getJson<{ links: Array<{ label: string }> }>();
    expect(links.map((l) => l.label)).toEqual(["Trip B"]);

    authService.revokeToken(token);
  });

  it("only reports passkeysAvailable once a public RP origin is configured", async () => {
    const previous = process.env.PHOTRIX_RP_ORIGIN;
    const { accountRequestHandler, authService } = await load();
    const passkeyService = await import("../auth/passkeyService.ts");
    // Passkey storage is "ready" (db configured) in both cases — only the RP
    // origin should gate the flag.
    passkeyService.initPasskeyService(makeTestDb());
    const token = authService.issueToken("henry");

    delete process.env.PHOTRIX_RP_ORIGIN;
    const withoutOrigin = createJsonResponse();
    await accountRequestHandler(makeReq("/api/account", "GET", token), withoutOrigin.res);
    expect(withoutOrigin.getJson<{ passkeysAvailable: boolean }>().passkeysAvailable).toBe(
      false,
    );

    process.env.PHOTRIX_RP_ORIGIN = "https://photos.example.com";
    const withOrigin = createJsonResponse();
    await accountRequestHandler(makeReq("/api/account", "GET", token), withOrigin.res);
    expect(withOrigin.getJson<{ passkeysAvailable: boolean }>().passkeysAvailable).toBe(true);

    authService.revokeToken(token);
    if (previous === undefined) delete process.env.PHOTRIX_RP_ORIGIN;
    else process.env.PHOTRIX_RP_ORIGIN = previous;
  });
});
