import { afterEach, describe, expect, it } from "@jest/globals";
import { getAuthConfig } from "./authConfig.ts";

const baselineEnv = {
  AUTH_ORIGIN: process.env.AUTH_ORIGIN,
  AUTH_ALLOWED_ORIGINS: process.env.AUTH_ALLOWED_ORIGINS,
  AUTH_ALLOWED_HOSTS: process.env.AUTH_ALLOWED_HOSTS,
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
});