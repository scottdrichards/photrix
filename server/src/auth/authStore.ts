import { mkdir } from "node:fs/promises";
import path from "node:path";
import { CACHE_DIR } from "../common/cacheUtils.ts";
import { AsyncSqlite } from "../common/asyncSqlite.ts";
import { measureOperation } from "../observability/requestTrace.ts";

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
  private lastExpiredSessionCleanupMs = 0;
  private static readonly EXPIRED_SESSION_CLEANUP_INTERVAL_MS = 60_000;

  private constructor(private readonly db: AsyncSqlite) {}

  static async create(): Promise<AuthStore> {
    const configuredPath = process.env.AUTH_DB_LOCATION?.trim();
    const directoryPath = configuredPath ? path.resolve(configuredPath) : path.resolve(CACHE_DIR);
    const dbFilePath = path.join(directoryPath, "auth.db");

    await mkdir(path.dirname(dbFilePath), { recursive: true });

    const db = await AsyncSqlite.open(dbFilePath, {
      pragmas: ["journal_mode = WAL"],
    });

    await db.exec(`
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

    return new AuthStore(db);
  }

  async countUsers(): Promise<number> {
    return measureOperation(
      "authStore.countUsers",
      async () => {
        const row = await this.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM auth_users");
        return row?.count ?? 0;
      },
      { category: "db", detail: "auth_users" },
    );
  }

  async findUserByUsername(username: string): Promise<AuthUser | null> {
    return measureOperation(
      "authStore.findUserByUsername",
      async () => {
        const row = await this.db.get<AuthUser>(
          "SELECT id, username FROM auth_users WHERE username = ?",
          username,
        );
        return row ?? null;
      },
      { category: "db", detail: username },
    );
  }

  async findOnlyUser(): Promise<AuthUser | null> {
    return measureOperation(
      "authStore.findOnlyUser",
      async () => {
        const row = await this.db.get<AuthUser>(
          "SELECT id, username FROM auth_users ORDER BY id ASC LIMIT 1",
        );
        return row ?? null;
      },
      { category: "db", detail: "auth_users" },
    );
  }

  async createUser(username: string): Promise<AuthUser> {
    return measureOperation(
      "authStore.createUser",
      async () => {
        const nowIso = new Date().toISOString();
        await this.db.run(
          "INSERT INTO auth_users (username, createdAt) VALUES (?, ?)",
          username, nowIso,
        );
        const user = await this.findUserByUsername(username);
        if (!user) {
          throw new Error("Unable to create auth user");
        }
        return user;
      },
      { category: "db", detail: username },
    );
  }

  async saveCredential(params: {
    credentialId: string;
    userId: number;
    publicKey: Uint8Array;
    counter: number;
    transports: string[];
  }): Promise<void> {
    await measureOperation(
      "authStore.saveCredential",
      async () => {
        const nowIso = new Date().toISOString();
        await this.db.run(
          `INSERT INTO auth_credentials (credentialId, userId, publicKey, counter, transports, createdAt)
           VALUES (?, ?, ?, ?, ?, ?)`,
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

  async listCredentialIdsByUserId(userId: number): Promise<string[]> {
    return measureOperation(
      "authStore.listCredentialIdsByUserId",
      async () => {
        const rows = await this.db.all<{ credentialId: string }>(
          "SELECT credentialId FROM auth_credentials WHERE userId = ?",
          userId,
        );
        return rows.map(({ credentialId }) => credentialId);
      },
      { category: "db", detail: String(userId) },
    );
  }

  async findCredential(credentialId: string): Promise<AuthCredential | null> {
    return measureOperation(
      "authStore.findCredential",
      async () => {
        const row = await this.db.get<{
          credentialId: string;
          userId: number;
          username: string;
          publicKey: Buffer;
          counter: number;
          transports: string | null;
        }>(
          `SELECT c.credentialId, c.userId, c.publicKey, c.counter, c.transports, u.username
           FROM auth_credentials c
           INNER JOIN auth_users u ON c.userId = u.id
           WHERE c.credentialId = ?`,
          credentialId,
        );

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

  async updateCredentialCounter(credentialId: string, nextCounter: number): Promise<void> {
    await measureOperation(
      "authStore.updateCredentialCounter",
      async () => {
        await this.db.run(
          "UPDATE auth_credentials SET counter = ? WHERE credentialId = ?",
          nextCounter, credentialId,
        );
      },
      { category: "db", detail: credentialId },
    );
  }

  async createSession(tokenHash: string, userId: number, expiresAtMs: number): Promise<void> {
    await measureOperation(
      "authStore.createSession",
      async () => {
        await this.maybeDeleteExpiredSessions();
        const nowIso = new Date().toISOString();
        await this.db.run(
          `INSERT OR REPLACE INTO auth_sessions (tokenHash, userId, expiresAtMs, createdAt)
           VALUES (?, ?, ?, ?)`,
          tokenHash, userId, expiresAtMs, nowIso,
        );
      },
      { category: "db", detail: String(userId) },
    );
  }

  async findSession(tokenHash: string): Promise<AuthSession | null> {
    return measureOperation(
      "authStore.findSession",
      async () => {
        await this.maybeDeleteExpiredSessions();

        const row = await this.db.get<{
          userId: number;
          username: string;
          expiresAtMs: number;
        }>(
          `SELECT s.userId, s.expiresAtMs, u.username
           FROM auth_sessions s
           INNER JOIN auth_users u ON s.userId = u.id
           WHERE s.tokenHash = ?`,
          tokenHash,
        );

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

  private async maybeDeleteExpiredSessions(): Promise<void> {
    const now = Date.now();
    if (
      now - this.lastExpiredSessionCleanupMs <
      AuthStore.EXPIRED_SESSION_CLEANUP_INTERVAL_MS
    ) {
      return;
    }

    this.lastExpiredSessionCleanupMs = now;
    await this.deleteExpiredSessions();
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await measureOperation(
      "authStore.deleteSession",
      async () => {
        await this.db.run("DELETE FROM auth_sessions WHERE tokenHash = ?", tokenHash);
      },
      { category: "db", detail: "session" },
    );
  }

  async deleteExpiredSessions(): Promise<void> {
    await measureOperation(
      "authStore.deleteExpiredSessions",
      async () => {
        await this.db.run("DELETE FROM auth_sessions WHERE expiresAtMs <= ?", Date.now());
      },
      { category: "db", detail: "auth_sessions" },
    );
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}
