import type http from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import {
  measureOperation,
  setCurrentSpanAttributes,
} from "../observability/requestTrace.ts";
import { writeJson } from "../utils.ts";
import { getAuthConfig } from "./authConfig.ts";
import { AuthStore } from "./authStore.ts";

type SessionUser = {
  userId: number;
  username: string;
};

type ChallengeState = {
  challenge: string;
  expiresAtMs: number;
};

type RateLimitState = {
  attempts: number[];
};

type RequestRejection = {
  status: number;
  error: string;
};

const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]{3,64}$/;
const textEncoder = new TextEncoder();

const parseCookies = (cookieHeader: string | undefined) => {
  if (!cookieHeader) {
    return new Map<string, string>();
  }

  return cookieHeader
    .split(";")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .reduce((cookies, chunk) => {
      const [name, ...valueParts] = chunk.split("=");
      if (!name) {
        return cookies;
      }

      cookies.set(name, decodeURIComponent(valueParts.join("=")));
      return cookies;
    }, new Map<string, string>());
};

const readJsonBody = async (
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  let size = 0;

  return new Promise((resolve, reject) => {
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Request body is too large"));
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) {
        resolve({});
        return;
      }

      try {
        const parsed = JSON.parse(text) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(new Error("JSON body must be an object"));
          return;
        }

        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });

    req.on("error", (error) => reject(error));
  });
};

const normalizeIp = (value: string | undefined) => {
  if (!value) {
    return "";
  }

  const cleaned = value.trim();
  if (!cleaned) {
    return "";
  }

  if (cleaned.startsWith("::ffff:")) {
    return cleaned.slice("::ffff:".length);
  }

  return cleaned;
};

const normalizeHost = (hostHeader: string | undefined) => {
  if (!hostHeader) {
    return "";
  }

  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return "";
  }
};

const firstHeaderValue = (header: string | string[] | undefined) => {
  if (Array.isArray(header)) {
    return header[0] ?? "";
  }

  return header ?? "";
};

const ensureSingleSetCookie = (res: http.ServerResponse, value: string) => {
  const current = res.getHeader("Set-Cookie");
  if (!current) {
    res.setHeader("Set-Cookie", value);
    return;
  }

  if (Array.isArray(current)) {
    res.setHeader("Set-Cookie", [...current, value]);
    return;
  }

  res.setHeader("Set-Cookie", [String(current), value]);
};

const hashToken = (token: string) => {
  return createHash("sha256").update(token).digest("hex");
};

const buildCookie = (
  name: string,
  value: string,
  secure: boolean,
  options: { maxAgeSeconds?: number; expires?: string; domain?: string } = {},
) => {
  const { maxAgeSeconds, expires, domain } = options;
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    ...(typeof maxAgeSeconds === "number" ? [`Max-Age=${maxAgeSeconds}`] : []),
    ...(expires ? [`Expires=${expires}`] : []),
    ...(domain ? [`Domain=${domain}`] : []),
    ...(secure ? ["Secure"] : []),
  ];

  return parts.join("; ");
};

const encodeCookie = (
  name: string,
  value: string,
  maxAgeSeconds: number,
  secure: boolean,
  domain?: string,
) => buildCookie(name, value, secure, { maxAgeSeconds, domain });

const clearCookie = (name: string, secure: boolean, domain?: string) => {
  return buildCookie(name, "", secure, {
    maxAgeSeconds: 0,
    expires: "Thu, 01 Jan 1970 00:00:00 GMT",
    domain,
  });
};

const safeString = (value: unknown) => {
  return typeof value === "string" ? value.trim() : "";
};

const compareSecrets = (provided: string, expected: string) => {
  const providedBuffer = Buffer.from(provided, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(providedBuffer, expectedBuffer);
};

export class AuthService {
  private readonly registrationChallengesByUsername = new Map<string, ChallengeState>();
  private readonly loginChallengesByUsername = new Map<string, ChallengeState>();
  private readonly rateLimitByKey = new Map<string, RateLimitState>();

  private constructor(
    private readonly config: ReturnType<typeof getAuthConfig>,
    private readonly store: AuthStore,
  ) {}

  static async create(): Promise<AuthService> {
    const config = getAuthConfig();
    const store = await AuthStore.create();
    return new AuthService(config, store);
  }

  get enabled() {
    return this.config.enabled;
  }

  private socketIp(req: http.IncomingMessage) {
    return normalizeIp(req.socket.remoteAddress);
  }

  private isTrustedProxy(req: http.IncomingMessage) {
    const socketIp = this.socketIp(req);
    if (!socketIp) {
      return false;
    }

    return this.config.trustedProxyIps.has(socketIp);
  }

  private hasForwardedHeader(req: http.IncomingMessage) {
    return ["x-forwarded-for", "x-forwarded-proto", "x-forwarded-host"].some((header) => {
      const value = req.headers[header];
      return typeof value === "string" ? value.length > 0 : Array.isArray(value) && value.length > 0;
    });
  }

  private clientIp(req: http.IncomingMessage) {
    if (!this.isTrustedProxy(req)) {
      return this.socketIp(req) || "unknown";
    }

    const forwarded = firstHeaderValue(req.headers["x-forwarded-for"])
      .split(",")
      .map((part) => normalizeIp(part))
      .find((part) => isIP(part) !== 0);

    return forwarded || this.socketIp(req) || "unknown";
  }

  private requestProtocol(req: http.IncomingMessage) {
    if ("encrypted" in req.socket && req.socket.encrypted) {
      return "https";
    }

    if (!this.isTrustedProxy(req)) {
      return "http";
    }

    const forwardedProto = firstHeaderValue(req.headers["x-forwarded-proto"])
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .find(Boolean);

    return forwardedProto || "http";
  }

  private hasAllowedHost(req: http.IncomingMessage) {
    const host = normalizeHost(firstHeaderValue(req.headers.host));
    if (!host) {
      return false;
    }

    return this.config.allowedHosts.has(host);
  }

  validateRequest(req: http.IncomingMessage): RequestRejection | null {
    if (!this.hasAllowedHost(req)) {
      return { status: 400, error: "Host not allowed" };
    }

    if (this.hasForwardedHeader(req) && !this.isTrustedProxy(req)) {
      return {
        status: 400,
        error:
          "Forwarded headers are only accepted from trusted proxies. Add your reverse proxy IP to AUTH_TRUSTED_PROXY_IPS.",
      };
    }

    if (this.config.requireHttps && this.requestProtocol(req) !== "https") {
      return { status: 400, error: "HTTPS is required" };
    }

    if (!this.isAllowedOrigin(req)) {
      return { status: 403, error: "Origin not allowed" };
    }

    return null;
  }

  applyResponseHeaders(req: http.IncomingMessage, res: http.ServerResponse) {
    const securityHeaders: Record<string, string> = {
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    };
    for (const [name, value] of Object.entries(securityHeaders)) {
      res.setHeader(name, value);
    }

    if (this.config.requireHttps) {
      res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
    }

    const origin = req.headers.origin;
    if (typeof origin === "string" && this.config.allowedOrigins.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }

    const corsHeaders: Record<string, string> = {
      Vary: "Origin",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    for (const [name, value] of Object.entries(corsHeaders)) {
      res.setHeader(name, value);
    }
  }

  isAllowedOrigin(req: http.IncomingMessage) {
    const origin = req.headers.origin;
    if (!origin) {
      return true;
    }

    return this.config.allowedOrigins.has(origin);
  }

  handlePreflight(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!this.isAllowedOrigin(req)) {
      writeJson(res, 403, { error: "Origin not allowed" });
      return;
    }

    res.writeHead(204);
    res.end();
  }

  private isRateLimited(req: http.IncomingMessage, routeKey: string, maxAttempts: number, windowMs: number) {
    const now = Date.now();
    const key = `${this.clientIp(req)}:${routeKey}`;
    const existing = this.rateLimitByKey.get(key) ?? { attempts: [] };
    const freshAttempts = existing.attempts.filter((timestamp) => now - timestamp < windowMs);
    if (freshAttempts.length >= maxAttempts) {
      this.rateLimitByKey.set(key, { attempts: freshAttempts });
      return true;
    }

    freshAttempts.push(now);
    this.rateLimitByKey.set(key, { attempts: freshAttempts });
    return false;
  }

  private async createSessionCookieForUser(userId: number, res: http.ServerResponse) {
    const rawToken = randomBytes(32).toString("base64url");
    const tokenHash = hashToken(rawToken);
    const expiresAtMs = Date.now() + this.config.sessionTtlMs;
    await this.store.createSession(tokenHash, userId, expiresAtMs);
    const cookieDomain = this.config.cookieName.startsWith("__Host-")
      ? undefined
      : this.config.rpId;

    ensureSingleSetCookie(
      res,
      encodeCookie(
        this.config.cookieName,
        rawToken,
        Math.max(Math.floor(this.config.sessionTtlMs / 1_000), 1),
        this.config.secureCookies,
        cookieDomain,
      ),
    );
  }

  private clearSessionCookie(res: http.ServerResponse) {
    const cookieDomain = this.config.cookieName.startsWith("__Host-")
      ? undefined
      : this.config.rpId;
    ensureSingleSetCookie(
      res,
      clearCookie(this.config.cookieName, this.config.secureCookies, cookieDomain),
    );
  }

  private async getSessionUser(req: http.IncomingMessage): Promise<SessionUser | null> {
    const cookie = parseCookies(req.headers.cookie).get(this.config.cookieName);
    if (!cookie) {
      return null;
    }

    const session = await this.store.findSession(hashToken(cookie));
    if (!session) {
      return null;
    }

    return {
      userId: session.userId,
      username: session.username,
    };
  }

  async requireAuthenticated(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!this.enabled) {
      return {
        userId: 0,
        username: "auth-disabled",
      } as SessionUser;
    }

    const sessionUser = await this.getSessionUser(req);
    if (!sessionUser) {
      writeJson(res, 401, { error: "Authentication required" });
      return null;
    }

    return sessionUser;
  }

  private validateChallenge(challengeState: ChallengeState | undefined, challengeValue: string) {
    if (!challengeState) {
      return false;
    }

    return challengeState.challenge === challengeValue && challengeState.expiresAtMs > Date.now();
  }

  private resolveRequestUrl(req: http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>) {
    const host = req.headers.host ?? "localhost";
    return new URL(req.url, `http://${host}`);
  }

  private async handleSessionRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    setCurrentSpanAttributes({ "photrix.auth.route": "session" });
    const hasUsers = await this.store.countUsers() > 0;
    const sessionUser = await this.getSessionUser(req);

    writeJson(res, 200, {
      authEnabled: this.enabled,
      setupRequired: this.enabled && !hasUsers,
      authenticated: Boolean(sessionUser),
      username: sessionUser?.username ?? null,
    });
  }

  private async handleLogoutRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    setCurrentSpanAttributes({ "photrix.auth.route": "logout" });
    const cookie = parseCookies(req.headers.cookie).get(this.config.cookieName);
    if (cookie) {
      await this.store.deleteSession(hashToken(cookie));
    }

    this.clearSessionCookie(res);
    writeJson(res, 200, { ok: true });
  }

  private async handleRegistrationOptionsRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) {
    setCurrentSpanAttributes({ "photrix.auth.route": "register.options" });
    if (await this.store.countUsers() > 0) {
      writeJson(res, 403, { error: "Registration is disabled" });
      return;
    }

    if (!this.config.bootstrapToken) {
      writeJson(res, 500, {
        error: "Bootstrap token is not configured",
        message: "Set AUTH_BOOTSTRAP_TOKEN to allow first-user registration",
      });
      return;
    }

    if (this.isRateLimited(req, "register-options", 8, 60_000)) {
      writeJson(res, 429, { error: "Too many requests" });
      return;
    }

    const body = await measureOperation(
      "auth.readJsonBody",
      () => readJsonBody(req, this.config.maxJsonBodyBytes),
      { category: "other", detail: "register.options" },
    );
    const username = safeString(body.username);
    const bootstrapToken = safeString(body.bootstrapToken);
    setCurrentSpanAttributes({ "photrix.auth.username": username || "unknown" });

    if (!USERNAME_PATTERN.test(username)) {
      writeJson(res, 400, { error: "Username must be 3-64 chars of a-z A-Z 0-9 . _ -" });
      return;
    }

    if (!compareSecrets(bootstrapToken, this.config.bootstrapToken)) {
      writeJson(res, 403, { error: "Invalid bootstrap token" });
      return;
    }

    const options = await measureOperation(
      "auth.generateRegistrationOptions",
      () =>
        generateRegistrationOptions({
          rpName: this.config.rpName,
          rpID: this.config.rpId,
          userName: username,
          userDisplayName: username,
          userID: textEncoder.encode(username),
          timeout: this.config.challengeTtlMs,
          authenticatorSelection: {
            residentKey: "required",
            userVerification: "required",
          },
          attestationType: "none",
          excludeCredentials: [],
        }),
      { category: "other", detail: username },
    );

    this.registrationChallengesByUsername.set(username, {
      challenge: options.challenge,
      expiresAtMs: Date.now() + this.config.challengeTtlMs,
    });

    writeJson(res, 200, options);
  }

  private async handleRegistrationVerifyRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    setCurrentSpanAttributes({ "photrix.auth.route": "register.verify" });
    if (await this.store.countUsers() > 0) {
      writeJson(res, 403, { error: "Registration is disabled" });
      return;
    }

    if (this.isRateLimited(req, "register-verify", 8, 60_000)) {
      writeJson(res, 429, { error: "Too many requests" });
      return;
    }

    const body = await measureOperation(
      "auth.readJsonBody",
      () => readJsonBody(req, this.config.maxJsonBodyBytes),
      { category: "other", detail: "register.verify" },
    );
    const username = safeString(body.username);
    setCurrentSpanAttributes({ "photrix.auth.username": username || "unknown" });

    if (!USERNAME_PATTERN.test(username)) {
      writeJson(res, 400, { error: "Invalid username" });
      return;
    }

    const challengeState = this.registrationChallengesByUsername.get(username);
    const response = body.response as Parameters<typeof verifyRegistrationResponse>[0]["response"];
    const challenge = challengeState?.challenge ?? "";

    const verification = await measureOperation(
      "auth.verifyRegistrationResponse",
      () =>
        verifyRegistrationResponse({
          response,
          expectedChallenge: challenge,
          expectedOrigin: Array.from(this.config.allowedOrigins),
          expectedRPID: this.config.rpId,
          requireUserVerification: true,
        }),
      { category: "other", detail: username },
    );

    const isValid = this.validateChallenge(challengeState, challenge);
    this.registrationChallengesByUsername.delete(username);

    if (!verification.verified || !verification.registrationInfo || !isValid) {
      writeJson(res, 401, { error: "Passkey verification failed" });
      return;
    }

    const user = await this.store.createUser(username);
    const { credential } = verification.registrationInfo;

    await this.store.saveCredential({
      credentialId: credential.id,
      userId: user.id,
      publicKey: credential.publicKey,
      counter: credential.counter,
      transports: credential.transports ?? [],
    });

    await this.createSessionCookieForUser(user.id, res);
    writeJson(res, 200, { ok: true, username: user.username });
  }

  private async handleLoginOptionsRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    setCurrentSpanAttributes({ "photrix.auth.route": "login.options" });
    if (await this.store.countUsers() === 0) {
      writeJson(res, 400, { error: "No users exist yet" });
      return;
    }

    if (this.isRateLimited(req, "login-options", 20, 60_000)) {
      writeJson(res, 429, { error: "Too many requests" });
      return;
    }

    const body = await measureOperation(
      "auth.readJsonBody",
      () => readJsonBody(req, this.config.maxJsonBodyBytes),
      { category: "other", detail: "login.options" },
    );
    const requestedUsername = safeString(body.username);

    const user = requestedUsername
      ? await this.store.findUserByUsername(requestedUsername)
      : await this.store.findOnlyUser();

    setCurrentSpanAttributes({
      "photrix.auth.username": requestedUsername || user?.username || "unknown",
    });

    if (!user) {
      writeJson(res, 404, { error: "User not found" });
      return;
    }

    const credentialIds = await this.store.listCredentialIdsByUserId(user.id);
    if (credentialIds.length === 0) {
      writeJson(res, 400, { error: "No passkeys registered for this user" });
      return;
    }

    const options = await measureOperation(
      "auth.generateAuthenticationOptions",
      () =>
        generateAuthenticationOptions({
          rpID: this.config.rpId,
          timeout: this.config.challengeTtlMs,
          userVerification: "required",
          allowCredentials: credentialIds.map((id) => ({ id, type: "public-key" })),
        }),
      { category: "other", detail: user.username },
    );

    this.loginChallengesByUsername.set(user.username, {
      challenge: options.challenge,
      expiresAtMs: Date.now() + this.config.challengeTtlMs,
    });

    writeJson(res, 200, {
      username: user.username,
      options,
    });
  }

  private async handleLoginVerifyRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    setCurrentSpanAttributes({ "photrix.auth.route": "login.verify" });
    if (this.isRateLimited(req, "login-verify", 20, 60_000)) {
      writeJson(res, 429, { error: "Too many requests" });
      return;
    }

    const body = await measureOperation(
      "auth.readJsonBody",
      () => readJsonBody(req, this.config.maxJsonBodyBytes),
      { category: "other", detail: "login.verify" },
    );
    const username = safeString(body.username);
    setCurrentSpanAttributes({ "photrix.auth.username": username || "unknown" });
    const challengeState = this.loginChallengesByUsername.get(username);
    const response = body.response as Parameters<typeof verifyAuthenticationResponse>[0]["response"];
    const credentialId = safeString(response.id);

    if (!credentialId || !challengeState) {
      writeJson(res, 401, { error: "Invalid authentication state" });
      return;
    }

    const credential = await this.store.findCredential(credentialId);
    if (!credential || credential.username !== username) {
      this.loginChallengesByUsername.delete(username);
      writeJson(res, 401, { error: "Invalid credential" });
      return;
    }

    const credentialPublicKey = new Uint8Array(credential.publicKey);
    const transports =
      credential.transports as Parameters<typeof verifyAuthenticationResponse>[0]["credential"]["transports"];

    const verification = await measureOperation(
      "auth.verifyAuthenticationResponse",
      () =>
        verifyAuthenticationResponse({
          response,
          expectedChallenge: challengeState.challenge,
          expectedOrigin: Array.from(this.config.allowedOrigins),
          expectedRPID: this.config.rpId,
          requireUserVerification: true,
          credential: {
            id: credential.credentialId,
            publicKey: credentialPublicKey,
            counter: credential.counter,
            transports,
          },
        }),
      { category: "other", detail: username },
    );

    const isValid = this.validateChallenge(challengeState, challengeState.challenge);
    this.loginChallengesByUsername.delete(username);

    if (!verification.verified || !verification.authenticationInfo || !isValid) {
      writeJson(res, 401, { error: "Passkey verification failed" });
      return;
    }

    await this.store.updateCredentialCounter(credential.credentialId, verification.authenticationInfo.newCounter);
    await this.createSessionCookieForUser(credential.userId, res);
    writeJson(res, 200, { ok: true, username: credential.username });
  }

  async handleAuthRequest(
    req: http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
    res: http.ServerResponse,
  ) {
    if (!req.url.startsWith("/api/auth/")) {
      return false;
    }

    if (!this.enabled && req.url !== "/api/auth/session") {
      writeJson(res, 400, { error: "Authentication is disabled" });
      return true;
    }

    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");

    const url = this.resolveRequestUrl(req);
    const pathname = url.pathname;
    setCurrentSpanAttributes({
      "photrix.auth.path": pathname,
      "photrix.auth.method": req.method ?? "UNKNOWN",
    });

    try {
      return await measureOperation(
        "auth.handleAuthRequest",
        async () => {
          if (pathname === "/api/auth/session" && req.method === "GET") {
            await this.handleSessionRequest(req, res);
            return true;
          }

          if (pathname === "/api/auth/logout" && req.method === "POST") {
            await this.handleLogoutRequest(req, res);
            return true;
          }

          if (pathname === "/api/auth/register/options" && req.method === "POST") {
            await this.handleRegistrationOptionsRequest(req, res);
            return true;
          }

          if (pathname === "/api/auth/register/verify" && req.method === "POST") {
            await this.handleRegistrationVerifyRequest(req, res);
            return true;
          }

          if (pathname === "/api/auth/login/options" && req.method === "POST") {
            await this.handleLoginOptionsRequest(req, res);
            return true;
          }

          if (pathname === "/api/auth/login/verify" && req.method === "POST") {
            await this.handleLoginVerifyRequest(req, res);
            return true;
          }

          writeJson(res, 404, { error: "Not found" });
          return true;
        },
        { category: "other", detail: pathname },
      );
    } catch (error) {
      console.error("[auth] request failed", error);
      writeJson(res, 400, {
        error: "Authentication request failed",
        message: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  }

  async close() {
    await this.store.close();
  }
}
