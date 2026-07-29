import { buildShareUrl } from "./useShareFilter";

describe("buildShareUrl", () => {
  it("returns a /share URL with only the token", () => {
    window.history.pushState(null, "", "/?includeSubfolders=false&q=sunset");

    const url = new URL(buildShareUrl("shared-token"));

    expect(url.pathname).toBe("/share");
    expect(url.searchParams.get("token")).toBe("shared-token");
    // No other params — filter state is encoded in the token itself.
    expect([...url.searchParams.keys()]).toEqual(["token"]);
  });

  it("does not append /share onto the current folder path", () => {
    window.history.pushState(null, "", "/travel/italy");

    const url = new URL(buildShareUrl("shared-token"));

    expect(url.pathname).toBe("/share");
    expect(url.searchParams.get("token")).toBe("shared-token");
    expect([...url.searchParams.keys()]).toEqual(["token"]);
  });
});
