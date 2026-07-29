import { buildFileUrl, buildFallbackUrl, buildFilesQueryUrl, createPhotoItem } from "./photoItem";

/**
 * Feedback #5: "/Sarah Pictures/2009/11/#2 Thankful for Dessert Night (8).jpg"
 * would not load. Unencoded, everything from the `#` is a URL fragment and never
 * leaves the browser, so the server sees a request for the folder. Every path
 * segment must be percent-encoded on the way into a URL.
 */
describe("file URL building with special characters", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  const reported = "Sarah Pictures/2009/11/#2 Thankful for Dessert Night (8).jpg";

  it("encodes '#' so it is not treated as a fragment", () => {
    const url = new URL(buildFileUrl(reported, {}));
    expect(url.hash).toBe("");
    expect(url.pathname).toContain("%232%20Thankful");
    // The server's decode must land back on the original path.
    expect(decodeURIComponent(url.pathname)).toBe(`/api/files/${reported}`);
  });

  it("encodes the other URL-structural characters but keeps separators", () => {
    for (const raw of [
      "a/b/why? really.jpg",
      "a/b/50% off.jpg",
      "a/b/x & y.jpg",
      "a/b/plus+one.jpg",
      "a/b/#hash#twice.jpg",
    ]) {
      const url = new URL(buildFileUrl(raw, {}));
      expect(url.hash).toBe("");
      expect(url.search).toBe("");
      expect(decodeURIComponent(url.pathname)).toBe(`/api/files/${raw}`);
      // Slashes stay real separators, not %2F.
      // "" + "api" + "files" + each raw segment
      expect(url.pathname.split("/")).toHaveLength(raw.split("/").length + 3);
    }
  });

  it("keeps query parameters separate from the encoded path", () => {
    const url = new URL(buildFileUrl(reported, { representation: "webSafe", height: "320" }));
    expect(url.searchParams.get("representation")).toBe("webSafe");
    expect(url.searchParams.get("height")).toBe("320");
    expect(decodeURIComponent(url.pathname)).toBe(`/api/files/${reported}`);
  });

  it("encodes '#' in the query URL and the fallback URL too", () => {
    expect(buildFilesQueryUrl("Sarah Pictures/#2 night", new URLSearchParams({ a: "b" }))).toBe(
      "/api/files/Sarah%20Pictures/%232%20night?a=b",
    );
    expect(new URL(buildFallbackUrl("Sarah Pictures/#2 night.jpg")).hash).toBe("");
  });

  it("builds every derivative URL of a photo without a fragment", () => {
    const photo = createPhotoItem({
      folder: "/Sarah Pictures/2009/11/",
      fileName: "#2 Thankful for Dessert Night (8).jpg",
    } as Parameters<typeof createPhotoItem>[0]);

    for (const url of [photo.originalUrl, photo.thumbnailUrl, photo.previewUrl, photo.fullUrl]) {
      expect(new URL(url).hash).toBe("");
      expect(url).toContain("%23");
    }
  });
});
