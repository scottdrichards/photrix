import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

afterEach(() => {
  jest.resetModules();
  jest.restoreAllMocks();
  delete process.env.PHOTRIX_SESSION_EXPIRY_DAYS;
  delete process.env.AUTH_PASSWORD;
});

describe("session token expiry", () => {
  it("validates a fresh session token", async () => {
    process.env.AUTH_PASSWORD = "test-password";
    const { issueToken, validateToken } = await import("./authService.ts");
    const token = issueToken("alice");
    expect(validateToken(token)).toBe(true);
  });

  it("rejects a session token past its inactivity window", async () => {
    process.env.AUTH_PASSWORD = "test-password";
    process.env.PHOTRIX_SESSION_EXPIRY_DAYS = "1"; // 1 day
    const { issueToken, validateToken, SESSION_EXPIRY_MS } = await import("./authService.ts");
    const token = issueToken("alice");

    // Advance time past expiry
    const future = Date.now() + SESSION_EXPIRY_MS + 1000;
    jest.spyOn(Date, "now").mockReturnValue(future);

    expect(validateToken(token)).toBe(false);
  });

  it("evicts the expired entry so a second call also returns false", async () => {
    process.env.AUTH_PASSWORD = "test-password";
    process.env.PHOTRIX_SESSION_EXPIRY_DAYS = "1";
    const { issueToken, validateToken, SESSION_EXPIRY_MS } = await import("./authService.ts");
    const token = issueToken("alice");

    const future = Date.now() + SESSION_EXPIRY_MS + 1000;
    jest.spyOn(Date, "now").mockReturnValue(future);

    validateToken(token); // first call evicts
    expect(validateToken(token)).toBe(false); // second call: Map miss
  });

  it("keeps a session alive when touched within the window", async () => {
    process.env.AUTH_PASSWORD = "test-password";
    process.env.PHOTRIX_SESSION_EXPIRY_DAYS = "1";
    const { issueToken, validateToken, SESSION_EXPIRY_MS } = await import("./authService.ts");
    const token = issueToken("alice");

    // Advance to 23h59m — still within window
    const almostExpired = Date.now() + SESSION_EXPIRY_MS - 60_000;
    jest.spyOn(Date, "now").mockReturnValue(almostExpired);

    expect(validateToken(token)).toBe(true);
  });
});
