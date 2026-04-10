import { afterEach, describe, expect, it } from "@jest/globals";
import { getAuthConfig } from "./authConfig.ts";

const baselineEnv = {
  AUTH_ORIGIN: process.env.AUTH_ORIGIN,
  AUTH_ALLOWED_ORIGINS: process.env.AUTH_ALLOWED_ORIGINS,
  AUTH_ALLOWED_HOSTS: process.env.AUTH_ALLOWED_HOSTS,
  AUTH_REQUIRED: process.env.AUTH_REQUIRED,
  NODE_ENV: process.env.NODE_ENV,
  PORT: process.env.PORT,
};

const restoreEnv = () => {
  Object.entries(baselineEnv).forEach(([key, value]) => {
    if (value === undefined) {
      delete process.env[key];
      return;
    }

    process.env[key] = value;
  });
};

describe("getAuthConfig", () => {
  afterEach(() => {
    restoreEnv();
  });

  it("derives origin, rpId, and allowed origins from allowedHosts", () => {
    delete process.env.AUTH_ORIGIN;
    delete process.env.AUTH_ALLOWED_ORIGINS;
    delete process.env.AUTH_RP_ID;
    process.env.AUTH_ALLOWED_HOSTS = "example.com,local.example.com,localhost";

    const config = getAuthConfig();

    expect(config.allowedHosts.has("localhost")).toBe(true);
    expect(config.allowedHosts.has("example.com")).toBe(true);
    expect(config.allowedHosts.has("local.example.com")).toBe(true);
    
    // Should derive origin, rpId from primary host
    expect(config.expectedOrigin).toBe("https://example.com");
    expect(config.rpId).toBe("example.com");
    
    // Should generate http and https variants for all hosts
    expect(config.allowedOrigins.has("https://example.com")).toBe(true);
    expect(config.allowedOrigins.has("http://example.com")).toBe(true);
    expect(config.allowedOrigins.has("https://localhost")).toBe(true);
  });

  it("defaults auth to disabled outside production", () => {
    delete process.env.AUTH_REQUIRED;
    delete process.env.NODE_ENV;

    const config = getAuthConfig();

    expect(config.enabled).toBe(false);
  });

  it("defaults auth to enabled in production", () => {
    delete process.env.AUTH_REQUIRED;
    process.env.NODE_ENV = "production";

    const config = getAuthConfig();

    expect(config.enabled).toBe(true);
  });

  it("respects explicit AUTH_REQUIRED regardless of NODE_ENV", () => {
    process.env.AUTH_REQUIRED = "true";
    delete process.env.NODE_ENV;

    expect(getAuthConfig().enabled).toBe(true);

    process.env.AUTH_REQUIRED = "false";
    process.env.NODE_ENV = "production";

    expect(getAuthConfig().enabled).toBe(false);
  });

  it("includes localhost port origins in non-production", () => {
    delete process.env.AUTH_ALLOWED_ORIGINS;
    delete process.env.NODE_ENV;
    process.env.AUTH_ALLOWED_HOSTS = "localhost";
    process.env.PORT = "3000";

    const config = getAuthConfig();

    expect(config.allowedOrigins.has("http://localhost:3000")).toBe(true);
    expect(config.allowedOrigins.has("http://localhost:5173")).toBe(true);
  });

  it("excludes localhost port origins in production", () => {
    delete process.env.AUTH_ALLOWED_ORIGINS;
    process.env.NODE_ENV = "production";
    process.env.AUTH_ALLOWED_HOSTS = "localhost";
    process.env.PORT = "3000";

    const config = getAuthConfig();

    expect(config.allowedOrigins.has("http://localhost:3000")).toBe(false);
    expect(config.allowedOrigins.has("http://localhost:5173")).toBe(false);
  });
});