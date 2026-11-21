import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { createPhotrixApi, encodeRelativePath, photrixBaseUrl } from "./photrixApi.ts";

describe("encodeRelativePath", () => {
  it("encodes each segment and drops the leading slash", () => {
    expect(encodeRelativePath("/2023/trip/#2 a?b.jpg")).toBe("2023/trip/%232%20a%3Fb.jpg");
    expect(encodeRelativePath("/..foo/x.jpg")).toBe("..foo/x.jpg");
  });

  // fetch resolves `.`/`..` (and `%2e`) before sending, so these would reach
  // another API route with the caller's token.
  it.each(["/a/../../api/feedback", "../x.jpg", "/a/./b.jpg", "/a/.."])("refuses %j", (p) => {
    expect(() => encodeRelativePath(p)).toThrow();
  });
});

describe("errors shown to MCP clients", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it("does not reveal the internal base URL when Photrix is unreachable", async () => {
    const stderr = jest.spyOn(console, "error").mockImplementation(() => {});
    globalThis.fetch = (async () => {
      throw new Error(`connect ECONNREFUSED ${photrixBaseUrl}`);
    });
    const error = await createPhotrixApi("t").getDateRange().then(
      () => null,
      (e: Error) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).not.toContain(photrixBaseUrl);
    expect(error?.message).not.toContain("ECONNREFUSED");
    // The operator still gets the cause, on the MCP process stderr.
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(photrixBaseUrl));
  });

  it("does not reveal the internal base URL on a timeout", async () => {
    globalThis.fetch = (async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    const error = await createPhotrixApi("t").getDateRange().then(
      () => null,
      (e: Error) => e,
    );
    expect(error?.message).toMatch(/timed out/);
    expect(error?.message).not.toContain(photrixBaseUrl);
  });
});
