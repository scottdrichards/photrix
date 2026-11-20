import { afterEach, describe, expect, it, jest } from "@jest/globals";

afterEach(() => {
  jest.resetModules();
  jest.restoreAllMocks();
  delete process.env.PHOTRIX_SESSION_EXPIRY_DAYS;
  delete process.env.AUTH_PASSWORD;
});

describe("session token expiry", () => {
  it("validates a fresh session token", async () => {
    process.env.AUTH_PASSWORD = "test-password";
    const { issueToken, validateToken } = await import("./authService.ts");
    const token = issueToken("alice");
    expect(validateToken(token)).toBe(true);
  });

  it("rejects a session token past its inactivity window", async () => {
    process.env.AUTH_PASSWORD = "test-password";
    process.env.PHOTRIX_SESSION_EXPIRY_DAYS = "1"; // 1 day
    const { issueToken, validateToken, SESSION_EXPIRY_MS } = await import("./authService.ts");
    const token = issueToken("alice");

    // Advance time past expiry
    const future = Date.now() + SESSION_EXPIRY_MS + 1000;
    jest.spyOn(Date, "now").mockReturnValue(future);

    expect(validateToken(token)).toBe(false);
  });

  it("evicts the expired entry so a second call also returns false", async () => {
    process.env.AUTH_PASSWORD = "test-password";
    process.env.PHOTRIX_SESSION_EXPIRY_DAYS = "1";
    const { issueToken, validateToken, SESSION_EXPIRY_MS } = await import("./authService.ts");
    const token = issueToken("alice");

    const future = Date.now() + SESSION_EXPIRY_MS + 1000;
    jest.spyOn(Date, "now").mockReturnValue(future);

    validateToken(token); // first call evicts
    expect(validateToken(token)).toBe(false); // second call: Map miss
  });

  it("keeps a session alive when touched within the window", async () => {
    process.env.AUTH_PASSWORD = "test-password";
    process.env.PHOTRIX_SESSION_EXPIRY_DAYS = "1";
    const { issueToken, validateToken, SESSION_EXPIRY_MS } = await import("./authService.ts");
    const token = issueToken("alice");

    // Advance to 23h59m — still within window
    const almostExpired = Date.now() + SESSION_EXPIRY_MS - 60_000;
    jest.spyOn(Date, "now").mockReturnValue(almostExpired);

    expect(validateToken(token)).toBe(true);
  });
});

// The share-token key used to fall back to AUTH_PASSWORD, so anyone holding a
// share link could test password guesses against it offline.
describe("share token secret", () => {
  afterEach(() => {
    delete process.env.PHOTRIX_SHARE_TOKEN_SECRET;
  });

  it("does not derive the share key from the account password", async () => {
    process.env.AUTH_PASSWORD = "test-password";
    const { issueShareToken } = await import("./authService.ts");
    expect(() => issueShareToken({ filter: { rating: 5 } })).toThrow("PHOTRIX_SHARE_TOKEN_SECRET");
  });

  it.each([
    ["missing", undefined],
    ["too short", "short-secret"],
  ])("refuses to start with auth enabled and the secret %s", async (_label, secret) => {
    process.env.AUTH_PASSWORD = "test-password";
    if (secret) process.env.PHOTRIX_SHARE_TOKEN_SECRET = secret;
    const { initAuthService } = await import("./authService.ts");
    await expect(initAuthService({} as never)).rejects.toThrow("PHOTRIX_SHARE_TOKEN_SECRET");
  });
});

describe("canonical usernames", () => {
  afterEach(() => {
    delete process.env.PHOTRIX_ACCOUNTS;
  });

  it("issues a session under the canonical account key whatever case was typed", async () => {
    process.env.PHOTRIX_ACCOUNTS = JSON.stringify([{ username: "Admin", password: "pw" }]);
    const { validateCredentials, getSessionUsername, listSessions } = await import(
      "./authService.ts"
    );
    const token = await validateCredentials("ADMIN", "pw");
    expect(token).not.toBeNull();
    expect(getSessionUsername(token!)).toBe("admin");
    expect(listSessions("admin")).toHaveLength(1);
  });

  it("resolves the owner of a session and of an API key, but not of a share token", async () => {
    process.env.AUTH_PASSWORD = "test-password";
    process.env.PHOTRIX_SHARE_TOKEN_SECRET = "test-share-secret-of-at-least-32-chars";
    const { issueToken, issueApiToken, issueShareToken, getTokenOwner } = await import(
      "./authService.ts"
    );
    expect(getTokenOwner(issueToken("alice"))).toBe("alice");
    expect(getTokenOwner(issueApiToken("alice", "k").token)).toBe("alice");
    expect(getTokenOwner(issueShareToken({ filter: { rating: 5 } }))).toBeNull();
    expect(getTokenOwner("nope")).toBeNull();
    delete process.env.PHOTRIX_SHARE_TOKEN_SECRET;
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

    process.env.AUTH_PASSWORD = "test-password";
    process.env.PHOTRIX_SHARE_TOKEN_SECRET = "test-share-secret-of-at-least-32-chars";
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
    delete process.env.PHOTRIX_SHARE_TOKEN_SECRET;
  });
});
