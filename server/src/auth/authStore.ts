import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { CACHE_DIR } from "../common/cacheUtils.ts";
import { measureSyncOperation } from "../observability/requestTrace.ts";

type AuthUser = {
  id: number;
  username: string;
};

type AuthCredential = {
  credentialId: string;
  userId: number;
  username: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
};

type AuthSession = {
  userId: number;
  username: string;
  expiresAtMs: number;
};

const parseTransports = (value: string | null) => {
  if (!value) {
    return [] as string[];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
};

export class AuthStore {
  private readonly db: Database.Database;
  private lastExpiredSessionCleanupMs = 0;
  private static readonly EXPIRED_SESSION_CLEANUP_INTERVAL_MS = 60_000;

  constructor() {
    const dbFilePath = this.resolveDbPath();
    mkdirSync(path.dirname(dbFilePath), { recursive: true });

    this.db = new Database(dbFilePath);
    this.db.pragma("journal_mode = WAL");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS auth_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        createdAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS auth_credentials (
        credentialId TEXT PRIMARY KEY,
        userId INTEGER NOT NULL,
        publicKey BLOB NOT NULL,
        counter INTEGER NOT NULL,
        transports TEXT,
        createdAt TEXT NOT NULL,
        FOREIGN KEY (userId) REFERENCES auth_users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS auth_sessions (
        tokenHash TEXT PRIMARY KEY,
        userId INTEGER NOT NULL,
        expiresAtMs INTEGER NOT NULL,
        createdAt TEXT NOT NULL,
        FOREIGN KEY (userId) REFERENCES auth_users(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_auth_credentials_userId ON auth_credentials(userId);
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_userId ON auth_sessions(userId);
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiresAt ON auth_sessions(expiresAtMs);
    `);
  }

  private resolveDbPath() {
    const configuredPath = process.env.AUTH_DB_LOCATION?.trim();
    const directoryPath = configuredPath ? path.resolve(configuredPath) : path.resolve(CACHE_DIR);
    return path.join(directoryPath, "auth.db");
  }

  countUsers() {
    return measureSyncOperation(
      "authStore.countUsers",
      () => {
        const row = this.db.prepare("SELECT COUNT(*) AS count FROM auth_users").get() as {
          count: number;
        };
        return row.count;
      },
      { category: "db", detail: "auth_users" },
    );
  }

  findUserByUsername(username: string) {
    return measureSyncOperation(
      "authStore.findUserByUsername",
      () => {
        const row = this.db
          .prepare("SELECT id, username FROM auth_users WHERE username = ?")
          .get(username) as AuthUser | undefined;

        return row ?? null;
      },
      { category: "db", detail: username },
    );
  }

  findOnlyUser() {
    return measureSyncOperation(
      "authStore.findOnlyUser",
      () => {
        const row = this.db
          .prepare("SELECT id, username FROM auth_users ORDER BY id ASC LIMIT 1")
          .get() as AuthUser | undefined;

        return row ?? null;
      },
      { category: "db", detail: "auth_users" },
    );
  }

  createUser(username: string) {
    return measureSyncOperation(
      "authStore.createUser",
      () => {
        const nowIso = new Date().toISOString();
        this.db.prepare("INSERT INTO auth_users (username, createdAt) VALUES (?, ?)").run(username, nowIso);
        const user = this.findUserByUsername(username);
        if (!user) {
          throw new Error("Unable to create auth user");
        }

        return user;
      },
      { category: "db", detail: username },
    );
  }

  saveCredential(params: {
    credentialId: string;
    userId: number;
    publicKey: Uint8Array;
    counter: number;
    transports: string[];
  }) {
    measureSyncOperation(
      "authStore.saveCredential",
      () => {
        const nowIso = new Date().toISOString();
        this.db
          .prepare(
            `INSERT INTO auth_credentials (credentialId, userId, publicKey, counter, transports, createdAt)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            params.credentialId,
            params.userId,
            Buffer.from(params.publicKey),
            params.counter,
            JSON.stringify(params.transports),
            nowIso,
          );
      },
      { category: "db", detail: params.credentialId },
    );
  }

  listCredentialIdsByUserId(userId: number) {
    return measureSyncOperation(
      "authStore.listCredentialIdsByUserId",
      () => {
        const rows = this.db
          .prepare("SELECT credentialId FROM auth_credentials WHERE userId = ?")
          .all(userId) as Array<{ credentialId: string }>;

        return rows.map(({ credentialId }) => credentialId);
      },
      { category: "db", detail: String(userId) },
    );
  }

  findCredential(credentialId: string) {
    return measureSyncOperation(
      "authStore.findCredential",
      () => {
        const row = this.db
          .prepare(
            `SELECT c.credentialId, c.userId, c.publicKey, c.counter, c.transports, u.username
             FROM auth_credentials c
             INNER JOIN auth_users u ON c.userId = u.id
             WHERE c.credentialId = ?`,
          )
          .get(credentialId) as
          | {
              credentialId: string;
              userId: number;
              username: string;
              publicKey: Buffer;
              counter: number;
              transports: string | null;
            }
          | undefined;

        if (!row) {
          return null;
        }

        return {
          credentialId: row.credentialId,
          userId: row.userId,
          username: row.username,
          publicKey: new Uint8Array(row.publicKey),
          counter: row.counter,
          transports: parseTransports(row.transports),
        } as AuthCredential;
      },
      { category: "db", detail: credentialId },
    );
  }

  updateCredentialCounter(credentialId: string, nextCounter: number) {
    measureSyncOperation(
      "authStore.updateCredentialCounter",
      () => {
        this.db
          .prepare("UPDATE auth_credentials SET counter = ? WHERE credentialId = ?")
          .run(nextCounter, credentialId);
      },
      { category: "db", detail: credentialId },
    );
  }

  createSession(tokenHash: string, userId: number, expiresAtMs: number) {
    measureSyncOperation(
      "authStore.createSession",
      () => {
        this.maybeDeleteExpiredSessions();
        const nowIso = new Date().toISOString();
        this.db
          .prepare(
            `INSERT OR REPLACE INTO auth_sessions (tokenHash, userId, expiresAtMs, createdAt)
             VALUES (?, ?, ?, ?)`,
          )
          .run(tokenHash, userId, expiresAtMs, nowIso);
      },
      { category: "db", detail: String(userId) },
    );
  }

  findSession(tokenHash: string) {
    return measureSyncOperation(
      "authStore.findSession",
      () => {
        this.maybeDeleteExpiredSessions();

        const row = this.db
          .prepare(
            `SELECT s.userId, s.expiresAtMs, u.username
             FROM auth_sessions s
             INNER JOIN auth_users u ON s.userId = u.id
             WHERE s.tokenHash = ?`,
          )
          .get(tokenHash) as
          | {
              userId: number;
              username: string;
              expiresAtMs: number;
            }
          | undefined;

        if (!row) {
          return null;
        }

        return {
          userId: row.userId,
          username: row.username,
          expiresAtMs: row.expiresAtMs,
        } as AuthSession;
      },
      { category: "db", detail: "session" },
    );
  }

  private maybeDeleteExpiredSessions() {
    const now = Date.now();
    if (
      now - this.lastExpiredSessionCleanupMs <
      AuthStore.EXPIRED_SESSION_CLEANUP_INTERVAL_MS
    ) {
      return;
    }

    this.lastExpiredSessionCleanupMs = now;
    this.deleteExpiredSessions();
  }

  deleteSession(tokenHash: string) {
    measureSyncOperation(
      "authStore.deleteSession",
      () => {
        this.db.prepare("DELETE FROM auth_sessions WHERE tokenHash = ?").run(tokenHash);
      },
      { category: "db", detail: "session" },
    );
  }

  deleteExpiredSessions() {
    measureSyncOperation(
      "authStore.deleteExpiredSessions",
      () => {
        this.db
          .prepare("DELETE FROM auth_sessions WHERE expiresAtMs <= ?")
          .run(Date.now());
      },
      { category: "db", detail: "auth_sessions" },
    );
  }

  close() {
    this.db.close();
  }
}
