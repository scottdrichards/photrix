import { beforeEach, describe, expect, it } from "@jest/globals";
import { LoginThrottledError, resetLoginThrottle, throttleLogin } from "./loginThrottle.ts";

const deferred = () => {
  let resolve: (value: string | null) => void = () => {};
  const promise = new Promise<string | null>((r) => (resolve = r));
  return { promise, resolve };
};

describe("throttleLogin", () => {
  beforeEach(() => resetLoginThrottle());

  it("passes a successful check through", async () => {
    await expect(throttleLogin("1.2.3.4", () => Promise.resolve("tok"))).resolves.toBe("tok");
  });

  it("runs at most two checks at once and queues the rest", async () => {
    const checks = Array.from({ length: 4 }, deferred);
    let started = 0;
    const logins = checks.map((check) =>
      throttleLogin("1.2.3.4", () => {
        started++;
        return check.promise;
      }),
    );
    await new Promise((r) => setImmediate(r));
    expect(started).toBe(2);

    checks[0].resolve("a");
    await logins[0];
    await new Promise((r) => setImmediate(r));
    expect(started).toBe(3);

    for (const check of checks) check.resolve("ok");
    await Promise.all(logins);
    expect(started).toBe(4);
  });

  it("refuses a login once the queue is full", async () => {
    const check = deferred();
    const logins = Array.from({ length: 18 }, () =>
      throttleLogin(null, () => check.promise),
    );
    // 2 running + 16 queued; the 19th has nowhere to wait.
    await expect(throttleLogin(null, () => check.promise)).rejects.toBeInstanceOf(
      LoginThrottledError,
    );
    check.resolve("ok");
    await Promise.all(logins);
  });

  it("locks out a client after 20 failures, and only that client", async () => {
    for (let i = 0; i < 20; i++) {
      await expect(throttleLogin("6.6.6.6", () => Promise.resolve(null))).resolves.toBeNull();
    }
    await expect(throttleLogin("6.6.6.6", () => Promise.resolve("tok"))).rejects.toMatchObject({
      retryAfterSeconds: expect.any(Number),
    });
    await expect(throttleLogin("7.7.7.7", () => Promise.resolve("tok"))).resolves.toBe("tok");
  });

  it("frees the slot when a check throws", async () => {
    for (let i = 0; i < 3; i++) {
      await expect(
        throttleLogin("1.2.3.4", () => Promise.reject(new Error("boom"))),
      ).rejects.toThrow("boom");
    }
    await expect(throttleLogin("1.2.3.4", () => Promise.resolve("tok"))).resolves.toBe("tok");
  });
});
