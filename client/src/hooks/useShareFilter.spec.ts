import { buildShareUrl } from "./useShareFilter";

describe("buildShareUrl", () => {
  it("hides the original semantic query and sources when adding a share token", () => {
    window.history.pushState(
      null,
      "",
      "/travel/italy?includeSubfolders=false&q=sunset&sources=image,transcript&view=people",
    );

    const url = new URL(buildShareUrl("shared-token"));

    expect(url.pathname).toBe("/travel/italy");
    expect(url.searchParams.get("token")).toBe("shared-token");
    expect(url.searchParams.get("includeSubfolders")).toBe("false");
    expect(url.searchParams.get("q")).toBeNull();
    expect(url.searchParams.get("sources")).toBeNull();
    expect(url.searchParams.get("view")).toBe("people");
  });
});
