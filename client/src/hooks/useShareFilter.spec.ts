import { buildShareUrl } from "./useShareFilter";

describe("buildShareUrl", () => {
  it("returns a /share URL with only the token", () => {
    // Any current path/params should be irrelevant — share links are self-contained.
    window.history.pushState(
      null,
      "",
      "/travel/italy?includeSubfolders=false&q=sunset&sources=image,transcript&view=people",
    );

    const url = new URL(buildShareUrl("shared-token"));

    expect(url.pathname).toBe("/share");
    expect(url.searchParams.get("token")).toBe("shared-token");
    // No other params — filter state is encoded in the token itself.
    expect([...url.searchParams.keys()]).toEqual(["token"]);
  });
});
