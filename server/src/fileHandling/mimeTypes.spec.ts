import { describe, expect, it } from "@jest/globals";
import { mimeTypeForFilename } from "./mimeTypes.ts";

describe("mimeTypeForFilename", () => {
  it("returns mime type for common image extension", () => {
    expect(mimeTypeForFilename("photo.JPG")).toBe("image/jpeg");
  });

  it("returns mime type for video extension", () => {
    expect(mimeTypeForFilename("movie.mkv")).toBe("video/x-matroska");
  });

  it("supports compound extensions", () => {
    expect(mimeTypeForFilename("archive.tar.gz")).toBe("application/gzip");
  });

  it("returns null for unknown extension", () => {
    expect(mimeTypeForFilename("README.unknownext")).toBeNull();
  });
});
