import { getAuthConfig, type AuthConfig } from "./authConfig.ts";

type CheckSeverity = "pass" | "warn" | "fail";

type CheckResult = {
  severity: CheckSeverity;
  message: string;
};

const productionLike = () => process.env.NODE_ENV?.trim().toLowerCase() === "production";

const hasInsecureOrigin = (origin: string) => origin.startsWith("http://");

const isLocalHost = (host: string) => ["localhost", "127.0.0.1", "::1"].includes(host);

const logCheck = (result: CheckResult) => {
  const tag =
    result.severity === "pass"
      ? "[auth:start:pass]"
      : result.severity === "warn"
        ? "[auth:start:warn]"
        : "[auth:start:fail]";

  const writer = result.severity === "fail" ? console.error : result.severity === "warn" ? console.warn : console.log;
  writer(`${tag} ${result.message}`);
};

const summarizeConfig = (config: AuthConfig) => {
  console.log("[auth:start] Effective security configuration");
  console.log(`[auth:start] authEnabled=${config.enabled}`);
  console.log(`[auth:start] requireHttps=${config.requireHttps}`);
  console.log(`[auth:start] secureCookies=${config.secureCookies}`);
  console.log(`[auth:start] expectedOrigin=${config.expectedOrigin}`);
  console.log(`[auth:start] rpId=${config.rpId}`);
  console.log(`[auth:start] allowedHosts=${Array.from(config.allowedHosts).join(",") || "<none>"}`);
  console.log(
    `[auth:start] trustedProxyIps=${Array.from(config.trustedProxyIps).join(",") || "<none>"}`,
  );
  console.log(
    `[auth:start] allowedOriginsCount=${config.allowedOrigins.size}, bootstrapTokenConfigured=${Boolean(config.bootstrapToken)}`,
  );
};

const validateProductionRequirements = (config: AuthConfig): CheckResult[] => {
  const results: CheckResult[] = [];

  if (!config.enabled) {
    results.push({
      severity: "fail",
      message: "AUTH_REQUIRED must be true in production deployments.",
    });
  } else {
    results.push({
      severity: "pass",
      message: "Authentication gate is enabled.",
    });
  }

  if (!config.requireHttps) {
    results.push({
      severity: "fail",
      message: "AUTH_REQUIRE_HTTPS must be true in production.",
    });
  } else {
    results.push({ severity: "pass", message: "HTTPS enforcement is enabled." });
  }

  if (!config.secureCookies) {
    results.push({
      severity: "fail",
      message: "AUTH_SECURE_COOKIES must be true in production.",
    });
  } else {
    results.push({ severity: "pass", message: "Secure cookies are enabled." });
  }

  if (hasInsecureOrigin(config.expectedOrigin)) {
    results.push({
      severity: "fail",
      message: `AUTH_ORIGIN must be HTTPS in production, got ${config.expectedOrigin}`,
    });
  } else {
    results.push({ severity: "pass", message: "AUTH_ORIGIN uses HTTPS." });
  }

  const insecureAllowedOrigins = Array.from(config.allowedOrigins).filter((origin) =>
    origin.startsWith("http://"),
  );
  if (insecureAllowedOrigins.length > 0) {
    results.push({
      severity: "fail",
      message: `AUTH_ALLOWED_ORIGINS contains insecure origins: ${insecureAllowedOrigins.join(", ")}`,
    });
  } else {
    results.push({ severity: "pass", message: "All allowed origins are HTTPS." });
  }

  if (config.allowedHosts.size === 0) {
    results.push({
      severity: "fail",
      message: "AUTH_ALLOWED_HOSTS must include at least one public hostname.",
    });
  } else {
    results.push({ severity: "pass", message: "Host allowlist is configured." });
  }

  if (config.trustedProxyIps.size === 0) {
    results.push({
      severity: "fail",
      message: "AUTH_TRUSTED_PROXY_IPS must include your reverse proxy IP(s).",
    });
  } else {
    results.push({ severity: "pass", message: "Trusted reverse proxy IP allowlist is configured." });
  }

  if (isLocalHost(config.rpId)) {
    results.push({
      severity: "fail",
      message: `AUTH_RP_ID must be your internet domain in production, got ${config.rpId}`,
    });
  } else {
    results.push({ severity: "pass", message: "Relying party ID looks non-local." });
  }

  return results;
};

const validateDevelopmentRecommendations = (config: AuthConfig): CheckResult[] => {
  const results: CheckResult[] = [];

  if (config.enabled) {
    results.push({ severity: "pass", message: "Authentication gate is enabled." });
  } else {
    results.push({ severity: "warn", message: "AUTH_REQUIRED is false; APIs are publicly reachable." });
  }

  if (!config.requireHttps) {
    results.push({ severity: "warn", message: "AUTH_REQUIRE_HTTPS is false (acceptable for local dev)." });
  }

  if (!config.secureCookies) {
    results.push({ severity: "warn", message: "AUTH_SECURE_COOKIES is false (acceptable for local dev)." });
  }

  if (config.trustedProxyIps.size === 0) {
    results.push({
      severity: "warn",
      message: "AUTH_TRUSTED_PROXY_IPS is empty; forwarded headers from proxies will be rejected.",
    });
  }

  if (!config.bootstrapToken) {
    results.push({
      severity: "warn",
      message: "AUTH_BOOTSTRAP_TOKEN is not set; first-user registration will fail until provided.",
    });
  }

  return results;
};

export const runAuthStartupChecks = () => {
  const config = getAuthConfig();
  const isProduction = productionLike();

  console.log(`[auth:start] Running startup security checks (mode=${isProduction ? "production" : "development"})`);
  summarizeConfig(config);

  const results = isProduction
    ? validateProductionRequirements(config)
    : validateDevelopmentRecommendations(config);

  results.forEach(logCheck);

  const failures = results.filter((result) => result.severity === "fail");
  if (failures.length > 0) {
    const summary = failures.map((failure) => `- ${failure.message}`).join("\n");
    throw new Error(`Authentication startup checks failed:\n${summary}`);
  }

  console.log("[auth:start] Startup security checks completed");
};
