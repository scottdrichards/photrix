import { describe, expect, it } from "@jest/globals";
import { escapeLikeLiteral } from "./sqlUtils.ts";

describe("escapeLikeLiteral", () => {
  it("escapes SQL LIKE wildcard symbols", () => {
    expect(escapeLikeLiteral("100%_done")).toBe("100\\%\\_done");
  });

  it("escapes backslashes", () => {
    expect(escapeLikeLiteral(String.raw`a\\b`)).toBe(String.raw`a\\\\b`);
  });

  it("returns unchanged plain text", () => {
    expect(escapeLikeLiteral("photos-2026")).toBe("photos-2026");
  });
});
