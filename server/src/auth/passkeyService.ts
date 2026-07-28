import { randomBytes } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
  WebAuthnCredential,
} from "@simplewebauthn/server";
import type { AsyncSqlite } from "../common/asyncSqlite.ts";

type ChallengeEntry = {
  challenge: string;
  username?: string;
  expiresAt: number;
};

type CredentialRow = {
  credentialId: string;
  username: string;
  publicKey: string;
  counter: number;
  transports: string | null;
};

const getRpConfig = () => {
  const origin =
    process.env.PHOTRIX_RP_ORIGIN ?? `http://localhost:${process.env.PORT ?? 3000}`;
  const rpID = new URL(origin).hostname;
  return { origin, rpID };
};

// In-memory challenge store (challenges are short-lived, ~2 min TTL).
const pendingChallenges = new Map<string, ChallengeEntry>();

const CHALLENGE_TTL_MS = 2 * 60 * 1000;

const cleanExpiredChallenges = () => {
  const now = Date.now();
  for (const [id, entry] of pendingChallenges) {
    if (entry.expiresAt < now) pendingChallenges.delete(id);
  }
};

const storeChallenge = (challenge: string, username?: string): string => {
  cleanExpiredChallenges();
  const sessionId = randomBytes(16).toString("hex");
  pendingChallenges.set(sessionId, {
    challenge,
    username,
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
  });
  return sessionId;
};

const consumeChallenge = (sessionId: string): ChallengeEntry | null => {
  const entry = pendingChallenges.get(sessionId);
  if (!entry || entry.expiresAt < Date.now()) {
    pendingChallenges.delete(sessionId);
    return null;
  }
  pendingChallenges.delete(sessionId);
  return entry;
};

let db: AsyncSqlite | null = null;

export const initPasskeyService = (database: AsyncSqlite): void => {
  db = database;
};

// Returns existing credential IDs for a user (to exclude from registration options).
const getCredentialsForUser = async (username: string) => {
  if (!db) return [];
  return db.all<CredentialRow>(
    "SELECT credentialId, transports FROM webauthn_credentials WHERE username = ?",
    [username],
  );
};

const getCredentialById = async (credentialId: string): Promise<CredentialRow | null> => {
  if (!db) return null;
  const rows = await db.all<CredentialRow>(
    "SELECT credentialId, username, publicKey, counter, transports FROM webauthn_credentials WHERE credentialId = ?",
    [credentialId],
  );
  return rows[0] ?? null;
};

export const isPasskeySupported = (): boolean => !!db;

// --- Registration ---

export const generatePasskeyRegistrationOptions = async (username: string) => {
  const { rpID } = getRpConfig();
  const existing = await getCredentialsForUser(username);
  const options = await generateRegistrationOptions({
    rpName: "Photrix",
    rpID,
    userName: username,
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({
      id: c.credentialId,
      transports: c.transports
        ? (JSON.parse(c.transports) as AuthenticatorTransportFuture[])
        : undefined,
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });
  const sessionId = storeChallenge(options.challenge, username);
  return { options, sessionId };
};

export const verifyPasskeyRegistration = async (
  sessionId: string,
  response: RegistrationResponseJSON,
): Promise<boolean> => {
  const entry = consumeChallenge(sessionId);
  if (!entry?.username) return false;

  const { origin, rpID } = getRpConfig();

  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: entry.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: false,
  });

  if (!verification.verified || !verification.registrationInfo) return false;

  const { credential } = verification.registrationInfo;

  const transports =
    (response.response.transports as AuthenticatorTransportFuture[] | undefined) ?? [];

  await db!.run(
    `INSERT OR REPLACE INTO webauthn_credentials
       (credentialId, username, publicKey, counter, transports, createdAt)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      credential.id,
      entry.username,
      Buffer.from(credential.publicKey).toString("base64"),
      credential.counter,
      JSON.stringify(transports),
      Date.now(),
    ],
  );

  return true;
};

// --- Management ---

export type PasskeyInfo = {
  credentialId: string;
  name: string | null;
  transports: string | null;
  createdAt: number;
};

export const listPasskeys = async (username: string): Promise<PasskeyInfo[]> => {
  if (!db) return [];
  return db.all<PasskeyInfo>(
    "SELECT credentialId, name, transports, createdAt FROM webauthn_credentials WHERE username = ? ORDER BY createdAt DESC",
    [username],
  );
};

export const deletePasskey = async (
  username: string,
  credentialId: string,
): Promise<boolean> => {
  if (!db) return false;
  const existing = await db.all<{ credentialId: string }>(
    "SELECT credentialId FROM webauthn_credentials WHERE credentialId = ? AND username = ?",
    [credentialId, username],
  );
  if (!existing[0]) return false;
  await db.run(
    "DELETE FROM webauthn_credentials WHERE credentialId = ? AND username = ?",
    [credentialId, username],
  );
  return true;
};

// --- Authentication ---

export const generatePasskeyAuthenticationOptions = async () => {
  const { rpID } = getRpConfig();
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "preferred",
    // No allowCredentials — the browser shows all passkeys for this RP (discoverable credential).
  });
  const sessionId = storeChallenge(options.challenge);
  return { options, sessionId };
};

export const verifyPasskeyAuthentication = async (
  sessionId: string,
  response: AuthenticationResponseJSON,
): Promise<string | null> => {
  const entry = consumeChallenge(sessionId);
  if (!entry) return null;

  const { origin, rpID } = getRpConfig();

  const credRow = await getCredentialById(response.id);
  if (!credRow) return null;

  const credential: WebAuthnCredential = {
    id: credRow.credentialId,
    publicKey: new Uint8Array(Buffer.from(credRow.publicKey, "base64")),
    counter: credRow.counter,
    transports: credRow.transports
      ? (JSON.parse(credRow.transports) as AuthenticatorTransportFuture[])
      : undefined,
  };

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: entry.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential,
    requireUserVerification: false,
  });

  if (!verification.verified) return null;

  // Update counter to prevent replay attacks.
  await db!.run("UPDATE webauthn_credentials SET counter = ? WHERE credentialId = ?", [
    verification.authenticationInfo.newCounter,
    credRow.credentialId,
  ]);

  return credRow.username;
};
