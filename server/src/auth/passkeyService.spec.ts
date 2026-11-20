import { afterEach, describe, expect, it, jest } from "@jest/globals";
import Database from "better-sqlite3";
import type { AsyncSqlite } from "../common/asyncSqlite.ts";

afterEach(() => {
  jest.resetModules();
  jest.restoreAllMocks();
});

const makeDb = () => {
  const raw = new Database(":memory:");
  raw.exec(
    "CREATE TABLE webauthn_credentials (credentialId TEXT PRIMARY KEY, username TEXT, publicKey TEXT, counter INTEGER, transports TEXT, name TEXT, createdAt INTEGER)",
  );
  const db = {
    all: async (sql: string, params: unknown[] = []) => raw.prepare(sql).all(...params),
    run: async (sql: string, params: unknown[] = []) => raw.prepare(sql).run(...params),
  } as unknown as AsyncSqlite;
  return { raw, db };
};

const mockWebauthn = () => {
  let n = 0;
  const verifyAuthenticationResponse = jest.fn(async () => ({
    verified: true,
    authenticationInfo: { newCounter: 1 },
  }));
  jest.unstable_mockModule("@simplewebauthn/server", () => ({
    generateAuthenticationOptions: jest.fn(async () => ({ challenge: `c${n++}` })),
    generateRegistrationOptions: jest.fn(async () => ({ challenge: `r${n++}` })),
    verifyAuthenticationResponse,
    verifyRegistrationResponse: jest.fn(async () => ({
      verified: true,
      registrationInfo: { credential: { id: "cred-1", publicKey: new Uint8Array([1]), counter: 0 } },
    })),
  }));
  return { verifyAuthenticationResponse };
};

describe("passkey challenge store", () => {
  it("caps the unauthenticated challenge map, evicting the oldest", async () => {
    const { verifyAuthenticationResponse } = mockWebauthn();
    const { raw, db } = makeDb();
    raw.prepare("INSERT INTO webauthn_credentials VALUES ('cred-1','Admin','AQ==',0,NULL,NULL,1)").run();
    const svc = await import("./passkeyService.ts");
    svc.initPasskeyService(db);

    const first = await svc.generatePasskeyAuthenticationOptions();
    let last = first;
    for (let i = 0; i < 1000; i++) last = await svc.generatePasskeyAuthenticationOptions();

    // The oldest challenge was evicted, so it can no longer be redeemed.
    expect(await svc.verifyPasskeyAuthentication(first.sessionId, { id: "cred-1" } as never)).toBeNull();
    expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
    // The newest still works, and yields the canonical (lower-case) account key.
    expect(await svc.verifyPasskeyAuthentication(last.sessionId, { id: "cred-1" } as never)).toBe("admin");
  });
});

describe("passkey registration ownership", () => {
  const register = async (owner: string, registrant: string) => {
    mockWebauthn();
    const { raw, db } = makeDb();
    raw.prepare("INSERT INTO webauthn_credentials VALUES ('cred-1',?,'old',5,NULL,NULL,1)").run(owner);
    process.env.PHOTRIX_RP_ORIGIN = "https://photos.example.com";
    const svc = await import("./passkeyService.ts");
    svc.initPasskeyService(db);
    const { sessionId } = await svc.generatePasskeyRegistrationOptions(registrant);
    const ok = await svc.verifyPasskeyRegistration(
      sessionId,
      { id: "cred-1", response: {} } as never,
      registrant,
    );
    const row = raw.prepare("SELECT username, publicKey FROM webauthn_credentials").get();
    delete process.env.PHOTRIX_RP_ORIGIN;
    return { ok, row };
  };

  it("refuses to overwrite another account's credential", async () => {
    const { ok, row } = await register("alice", "bob");
    expect(ok).toBe(false);
    expect(row).toEqual({ username: "alice", publicKey: "old" });
  });

  it("lets an account re-register its own credential", async () => {
    const { ok, row } = await register("alice", "alice");
    expect(ok).toBe(true);
    expect(row).toMatchObject({ username: "alice" });
  });
});
