import { describe, expect, it } from "@jest/globals";
import { stripLeadingSlash } from "./stripLeadingSlash.ts";

describe("stripLeadingSlash", () => {
  it("removes a leading forward slash", () => {
    expect(stripLeadingSlash("/photos/file.jpg")).toBe("photos/file.jpg");
  });

  it("removes a leading escaped forward slash", () => {
    expect(stripLeadingSlash("\\/photos/file.jpg")).toBe("photos/file.jpg");
  });

  it("leaves values without a leading slash unchanged", () => {
    expect(stripLeadingSlash("photos/file.jpg")).toBe("photos/file.jpg");
  });
});
