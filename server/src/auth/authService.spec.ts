import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { overrideConfig } from "../config/config.fixture.ts";

afterEach(() => {
  jest.resetModules();
  jest.restoreAllMocks();
  overrideConfig({ PHOTRIX_SESSION_EXPIRY_DAYS: undefined });
  overrideConfig({ AUTH_PASSWORD: undefined });
});

describe("session token expiry", () => {
  it("validates a fresh session token", async () => {
    overrideConfig({ AUTH_PASSWORD: "test-password" });
    const { issueToken, validateToken } = await import("./authService.ts");
    const token = issueToken("alice");
    expect(validateToken(token)).toBe(true);
  });

  it("rejects a session token past its inactivity window", async () => {
    overrideConfig({ AUTH_PASSWORD: "test-password" });
    overrideConfig({ PHOTRIX_SESSION_EXPIRY_DAYS: "1" }); // 1 day
    const { issueToken, validateToken, sessionExpiryMs } = await import("./authService.ts");
    const token = issueToken("alice");

    // Advance time past expiry
    const future = Date.now() + sessionExpiryMs() + 1000;
    jest.spyOn(Date, "now").mockReturnValue(future);

    expect(validateToken(token)).toBe(false);
  });

  it("evicts the expired entry so a second call also returns false", async () => {
    overrideConfig({ AUTH_PASSWORD: "test-password" });
    overrideConfig({ PHOTRIX_SESSION_EXPIRY_DAYS: "1" });
    const { issueToken, validateToken, sessionExpiryMs } = await import("./authService.ts");
    const token = issueToken("alice");

    const future = Date.now() + sessionExpiryMs() + 1000;
    jest.spyOn(Date, "now").mockReturnValue(future);

    validateToken(token); // first call evicts
    expect(validateToken(token)).toBe(false); // second call: Map miss
  });

  it("keeps a session alive when touched within the window", async () => {
    overrideConfig({ AUTH_PASSWORD: "test-password" });
    overrideConfig({ PHOTRIX_SESSION_EXPIRY_DAYS: "1" });
    const { issueToken, validateToken, sessionExpiryMs } = await import("./authService.ts");
    const token = issueToken("alice");

    // Advance to 23h59m — still within window
    const almostExpired = Date.now() + sessionExpiryMs() - 60_000;
    jest.spyOn(Date, "now").mockReturnValue(almostExpired);

    expect(validateToken(token)).toBe(true);
  });
});

// The share-token key used to fall back to AUTH_PASSWORD, so anyone holding a
// share link could test password guesses against it offline.
describe("share token secret", () => {
  afterEach(() => {
    overrideConfig({ PHOTRIX_SHARE_TOKEN_SECRET: undefined });
  });

  it("does not derive the share key from the account password", async () => {
    overrideConfig({ AUTH_PASSWORD: "test-password" });
    const { issueShareToken } = await import("./authService.ts");
    expect(() => issueShareToken({ filter: { rating: 5 } })).toThrow("PHOTRIX_SHARE_TOKEN_SECRET");
  });

  it("refuses to start with auth enabled and the secret missing", async () => {
    overrideConfig({ AUTH_PASSWORD: "test-password" });
    const { initAuthService } = await import("./authService.ts");
    await expect(initAuthService({} as never)).rejects.toThrow("PHOTRIX_SHARE_TOKEN_SECRET");
  });

  it("refuses a secret that is too short", () => {
    expect(() => overrideConfig({ PHOTRIX_SHARE_TOKEN_SECRET: "short-secret" })).toThrow(
      "PHOTRIX_SHARE_TOKEN_SECRET: must be at least 32 characters",
    );
  });
});

describe("canonical usernames", () => {
  afterEach(() => {
    overrideConfig({ PHOTRIX_ACCOUNTS: undefined });
  });

  it("issues a session under the canonical account key whatever case was typed", async () => {
    overrideConfig({ PHOTRIX_ACCOUNTS: JSON.stringify([{ username: "Admin", password: "pw" }]) });
    const { validateCredentials, getSessionUsername, listSessions } = await import(
      "./authService.ts"
    );
    const token = await validateCredentials("ADMIN", "pw");
    expect(token).not.toBeNull();
    expect(getSessionUsername(token!)).toBe("admin");
    expect(listSessions("admin")).toHaveLength(1);
  });

  it("resolves the owner of a session and of an API key, but not of a share token", async () => {
    overrideConfig({ AUTH_PASSWORD: "test-password" });
    overrideConfig({ PHOTRIX_SHARE_TOKEN_SECRET: "test-share-secret-of-at-least-32-chars" });
    const { issueToken, issueApiToken, issueShareToken, getTokenOwner } = await import(
      "./authService.ts"
    );
    expect(getTokenOwner(issueToken("alice"))).toBe("alice");
    expect(getTokenOwner(issueApiToken("alice", "k").token)).toBe("alice");
    expect(getTokenOwner(issueShareToken({ filter: { rating: 5 } }))).toBeNull();
    expect(getTokenOwner("nope")).toBeNull();
    overrideConfig({ PHOTRIX_SHARE_TOKEN_SECRET: undefined });
  });

  it("rewrites mixed-case usernames at startup so hidden rows reach their owner", async () => {
    const { default: Database } = await import("better-sqlite3");
    const raw = new Database(":memory:");
    raw.exec("CREATE TABLE auth_sessions (token TEXT PRIMARY KEY, username TEXT, createdAt INTEGER, ip TEXT, lastSeenAt INTEGER)");
    raw.exec("CREATE TABLE api_tokens (token TEXT PRIMARY KEY, username TEXT, name TEXT, createdAt INTEGER, lastUsedAt INTEGER)");
    raw.exec("CREATE TABLE share_links (token TEXT PRIMARY KEY, username TEXT, label TEXT, createdAt INTEGER, revokedAt INTEGER)");
    raw.exec("CREATE TABLE webauthn_credentials (credentialId TEXT PRIMARY KEY, username TEXT, publicKey TEXT, counter INTEGER, transports TEXT, name TEXT, createdAt INTEGER)");
    const now = Date.now();
    raw.prepare("INSERT INTO auth_sessions VALUES ('s1','Admin',?,NULL,?)").run(now, now);
    raw.prepare("INSERT INTO api_tokens VALUES ('k1','ADMIN','n',?,NULL)").run(now);
    raw.prepare("INSERT INTO share_links VALUES ('l1','Admin','x',?,NULL)").run(now);
    raw.prepare("INSERT INTO webauthn_credentials VALUES ('c1','Admin','pk',0,NULL,NULL,?)").run(now);
    const db = {
      all: async (sql: string, params: unknown[] = []) => raw.prepare(sql).all(...params),
      run: async (sql: string, params: unknown[] = []) => raw.prepare(sql).run(...params),
      get: async (sql: string, params: unknown[] = []) => raw.prepare(sql).get(...params),
    } as unknown as import("../common/asyncSqlite.ts").AsyncSqlite;

    overrideConfig({ AUTH_PASSWORD: "test-password" });
    overrideConfig({ PHOTRIX_SHARE_TOKEN_SECRET: "test-share-secret-of-at-least-32-chars" });
    const { initAuthService, listSessions, listApiTokens, listShareLinks, revokeSessionsForUser } =
      await import("./authService.ts");
    await initAuthService(db);

    expect(listSessions("admin").map((s) => s.token)).toEqual(["s1"]);
    expect((await listApiTokens("admin")).map((k) => k.token)).toEqual(["k1"]);
    expect((await listShareLinks("admin")).map((l) => l.token)).toEqual(["l1"]);
    expect(raw.prepare("SELECT username FROM webauthn_credentials").get()).toEqual({
      username: "admin",
    });
    await revokeSessionsForUser("admin");
    expect(listSessions("admin")).toHaveLength(0);
    overrideConfig({ PHOTRIX_SHARE_TOKEN_SECRET: undefined });
  });
});
