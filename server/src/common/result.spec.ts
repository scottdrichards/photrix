import { describe, expect, it } from "@jest/globals";
import { attempt, attemptSync, isNotFound } from "./result.ts";

describe("attempt", () => {
  it("returns the value of work that succeeds", async () => {
    await expect(attempt(Promise.resolve(3))).resolves.toEqual({ ok: true, value: 3 });
  });

  it("returns the error of work that fails, as an Error even when a non-Error was thrown", async () => {
    const failed = await attempt(Promise.reject(new Error("boom")));
    expect(failed).toEqual({ ok: false, error: new Error("boom") });

    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the case under test
    const odd = await attempt(Promise.reject("just a string"));
    expect(odd.ok).toBe(false);
    expect(!odd.ok && odd.error).toBeInstanceOf(Error);
    expect(!odd.ok && odd.error.cause).toBe("just a string");
  });
});

describe("attemptSync", () => {
  it("captures a throw instead of propagating it", () => {
    expect(attemptSync(() => JSON.parse("{"))).toMatchObject({ ok: false });
    expect(attemptSync(() => JSON.parse("[1]") as number[])).toEqual({ ok: true, value: [1] });
  });
});

describe("isNotFound", () => {
  it("recognizes ENOENT and nothing else", () => {
    expect(isNotFound(Object.assign(new Error("gone"), { code: "ENOENT" }))).toBe(true);
    expect(isNotFound(Object.assign(new Error("io"), { code: "EIO" }))).toBe(false);
  });
});
