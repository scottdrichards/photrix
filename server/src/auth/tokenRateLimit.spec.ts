import { afterEach, describe, expect, it } from "@jest/globals";
import { resetTokenRateLimits, takeRequest } from "./tokenRateLimit.ts";

describe("takeRequest", () => {
  afterEach(() => {
    resetTokenRateLimits();
    delete process.env.PHOTRIX_RATE_SHARE_BURST;
    delete process.env.PHOTRIX_RATE_SHARE_PER_SECOND;
  });

  const spend = (token: string, count: number, now: number) => {
    let allowed = 0;
    for (let i = 0; i < count; i++) {
      if (takeRequest(token, "share", now).allowed) allowed++;
    }
    return allowed;
  };

  it("allows a burst up to the bucket size, then refuses with a retry delay", () => {
    process.env.PHOTRIX_RATE_SHARE_BURST = "5";
    process.env.PHOTRIX_RATE_SHARE_PER_SECOND = "1";

    expect(spend("t", 5, 0)).toBe(5);
    expect(takeRequest("t", "share", 0)).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it("refills at the configured rate", () => {
    process.env.PHOTRIX_RATE_SHARE_BURST = "5";
    process.env.PHOTRIX_RATE_SHARE_PER_SECOND = "2";

    spend("t", 5, 0);
    expect(spend("t", 10, 1000)).toBe(2);
    expect(spend("t", 10, 60_000)).toBe(5);
  });

  it("keeps each token's budget separate", () => {
    process.env.PHOTRIX_RATE_SHARE_BURST = "3";

    spend("a", 3, 0);
    expect(takeRequest("a", "share", 0).allowed).toBe(false);
    expect(takeRequest("b", "share", 0).allowed).toBe(true);
  });

  it("gives a signed-in session room for the grid's thumbnail bursts", () => {
    let allowed = 0;
    for (let i = 0; i < 1000; i++) {
      if (takeRequest("session", "session", 0).allowed) allowed++;
    }
    expect(allowed).toBe(1000);
  });
});
