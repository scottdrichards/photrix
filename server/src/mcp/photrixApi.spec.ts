import { describe, expect, it } from "@jest/globals";
import { encodeRelativePath } from "./photrixApi.ts";

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
