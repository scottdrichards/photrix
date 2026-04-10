export type AuthConfig = {
  enabled: boolean;
  rpName: string;
  rpId: string;
  expectedOrigin: string;
  allowedOrigins: Set<string>;
  allowedHosts: Set<string>;
  trustedProxyIps: Set<string>;
  requireHttps: boolean;
  bootstrapToken: string | null;
  sessionTtlMs: number;
  secureCookies: boolean;
  cookieName: string;
  challengeTtlMs: number;
  maxJsonBodyBytes: number;
};

const parseBoolean = (value: string | undefined, fallback: boolean) => {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
};

const parseInteger = (value: string | undefined, fallback: number) => {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
};

const parseOrigins = (value: string | undefined, fallback: string[]) => {
  const sources = value
    ? value
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean)
    : fallback;

  return new Set(sources);
};

const parseList = (value: string | undefined, fallback: string[]) => {
  const source = value
    ? value
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean)
    : fallback;

  return new Set(source);
};

export const getAuthConfig = (): AuthConfig => {
  const secureCookies = parseBoolean(
    process.env.AUTH_SECURE_COOKIES,
    process.env.NODE_ENV === "production",
  );

  // Single source of truth for allowed hosts
  const allowedHosts = parseList(process.env.AUTH_ALLOWED_HOSTS, ["localhost"]);
  const primaryHost = Array.from(allowedHosts)[0] || "localhost";

  // Derive origin and origins from allowed hosts
  const expectedOrigin = process.env.AUTH_ORIGIN?.trim() || `https://${primaryHost}`;
  const rpId = process.env.AUTH_RP_ID?.trim() || primaryHost;

  // Generate allowed origins from hosts (both http and https)
  const generateOrigins = (): string[] => {
    const origins = new Set<string>();
    for (const host of allowedHosts) {
      origins.add(`https://${host}`);
      if (!host.startsWith("localhost") || process.env.NODE_ENV !== "production") {
        origins.add(`http://${host}`);
      }
      if (host === "localhost" && process.env.NODE_ENV !== "production") {
        const serverPort = process.env.PORT || "3000";
        origins.add(`http://localhost:${serverPort}`);
        origins.add(`http://localhost:5173`);
      }
    }
    origins.add(expectedOrigin);
    return Array.from(origins);
  };

  const allowedOrigins = parseOrigins(process.env.AUTH_ALLOWED_ORIGINS, generateOrigins());

  return {
    enabled: parseBoolean(process.env.AUTH_REQUIRED, process.env.NODE_ENV === "production"),
    rpName: process.env.AUTH_RP_NAME?.trim() || "Photrix",
    rpId,
    expectedOrigin,
    allowedOrigins,
    allowedHosts,
    trustedProxyIps: parseList(process.env.AUTH_TRUSTED_PROXY_IPS, []),
    requireHttps: parseBoolean(process.env.AUTH_REQUIRE_HTTPS, secureCookies),
    bootstrapToken: process.env.AUTH_BOOTSTRAP_TOKEN?.trim() || null,
    sessionTtlMs: parseInteger(process.env.AUTH_SESSION_TTL_SECONDS, 60 * 60 * 24 * 7) * 1_000,
    secureCookies,
    cookieName: secureCookies ? "__Host-photrix_session" : "photrix_session",
    challengeTtlMs: parseInteger(process.env.AUTH_CHALLENGE_TTL_SECONDS, 120) * 1_000,
    maxJsonBodyBytes: parseInteger(process.env.AUTH_MAX_JSON_BYTES, 16 * 1_024),
  };
};
