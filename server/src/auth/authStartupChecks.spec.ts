import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { runAuthStartupChecks } from "./authStartupChecks.ts";

const baselineEnv = {
  NODE_ENV: process.env.NODE_ENV,
  AUTH_REQUIRED: process.env.AUTH_REQUIRED,
  AUTH_REQUIRE_HTTPS: process.env.AUTH_REQUIRE_HTTPS,
  AUTH_SECURE_COOKIES: process.env.AUTH_SECURE_COOKIES,
  AUTH_ORIGIN: process.env.AUTH_ORIGIN,
  AUTH_ALLOWED_ORIGINS: process.env.AUTH_ALLOWED_ORIGINS,
  AUTH_ALLOWED_HOSTS: process.env.AUTH_ALLOWED_HOSTS,
  AUTH_TRUSTED_PROXY_IPS: process.env.AUTH_TRUSTED_PROXY_IPS,
  AUTH_RP_ID: process.env.AUTH_RP_ID,
  AUTH_BOOTSTRAP_TOKEN: process.env.AUTH_BOOTSTRAP_TOKEN,
};

const setEnv = (values: Record<string, string | undefined>) => {
  Object.entries(values).forEach(([key, value]) => {
    if (value === undefined) {
      delete process.env[key];
      return;
    }

    process.env[key] = value;
  });
};

describe("runAuthStartupChecks", () => {
  const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

  beforeEach(() => {
    logSpy.mockClear();
    warnSpy.mockClear();
    errorSpy.mockClear();
  });

  afterEach(() => {
    setEnv(baselineEnv);
  });

  afterAll(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("passes strict production configuration", () => {
    setEnv({
      NODE_ENV: "production",
      AUTH_REQUIRED: "true",
      AUTH_REQUIRE_HTTPS: "true",
      AUTH_SECURE_COOKIES: "true",
      AUTH_ORIGIN: "https://photos.example.com",
      AUTH_ALLOWED_ORIGINS: "https://photos.example.com",
      AUTH_ALLOWED_HOSTS: "photos.example.com",
      AUTH_TRUSTED_PROXY_IPS: "192.168.1.97",
      AUTH_RP_ID: "photos.example.com",
      AUTH_BOOTSTRAP_TOKEN: "very-long-secret-token",
    });

    expect(() => runAuthStartupChecks()).not.toThrow();
    expect(logSpy).toHaveBeenCalledWith(
      "[auth:start] Running startup security checks (mode=production)",
    );
  });

  it("fails production startup when trusted proxy list is missing", () => {
    setEnv({
      NODE_ENV: "production",
      AUTH_REQUIRED: "true",
      AUTH_REQUIRE_HTTPS: "true",
      AUTH_SECURE_COOKIES: "true",
      AUTH_ORIGIN: "https://photos.example.com",
      AUTH_ALLOWED_ORIGINS: "https://photos.example.com",
      AUTH_ALLOWED_HOSTS: "photos.example.com",
      AUTH_TRUSTED_PROXY_IPS: "",
      AUTH_RP_ID: "photos.example.com",
      AUTH_BOOTSTRAP_TOKEN: "very-long-secret-token",
    });

    expect(() => runAuthStartupChecks()).toThrow(
      "AUTH_TRUSTED_PROXY_IPS must include your reverse proxy IP(s).",
    );
  });

  it("warns in development for insecure settings but does not fail", () => {
    setEnv({
      NODE_ENV: "development",
      AUTH_REQUIRED: "true",
      AUTH_REQUIRE_HTTPS: "false",
      AUTH_SECURE_COOKIES: "false",
      AUTH_ORIGIN: "http://localhost:5173",
      AUTH_ALLOWED_ORIGINS: "http://localhost:5173",
      AUTH_ALLOWED_HOSTS: "localhost",
      AUTH_TRUSTED_PROXY_IPS: "",
      AUTH_RP_ID: "localhost",
      AUTH_BOOTSTRAP_TOKEN: undefined,
    });

    expect(() => runAuthStartupChecks()).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
  });
});
