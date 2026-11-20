import { describe, expect, it } from "@jest/globals";
import os from "node:os";
import path from "node:path";

// Read from the environment when the module loads.
const cacheRoot = path.join(os.tmpdir(), "photrix-cacheutils-spec");
process.env.CACHE_DIR = cacheRoot;
process.env.HLS_CACHE_DIR = path.join(cacheRoot, "hls");

const {
  MEDIA_CACHE_DIR,
  HLS_CACHE_DIR,
  getMirroredCacheBaseDirectory,
  getMirroredCachedFilePath,
  getMirroredHLSDirectory,
} = await import("./cacheUtils.ts");
const { PathContainmentError, isPathInside } = await import("./pathContainment.ts");

describe("mirrored cache paths", () => {
  it("keeps the established layout for ordinary names", () => {
    expect(getMirroredCachedFilePath("/library/2023/trip/img.jpg", 320, "webp")).toBe(
      path.join(MEDIA_CACHE_DIR, "root", "library/2023/trip", "img", "320.webp"),
    );
    expect(getMirroredHLSDirectory("/library/2023/clip.mp4", "abr")).toBe(
      path.join(HLS_CACHE_DIR, "root", "library/2023", "clip", "hls", "abr"),
    );
  });

  it("keeps names that only start with dots", () => {
    expect(getMirroredCacheBaseDirectory("/library/..foo.jpg")).toBe(
      path.join(MEDIA_CACHE_DIR, "root", "library", "..foo"),
    );
  });

  // `..jpg` has the stem `.`, `...jpg` the stem `..`: joined raw, their cache
  // directories would be their folder, or its parent, which other files own.
  it.each(["/library/album/..jpg", "/library/album/...jpg"])(
    "gives %j its own cache directory inside its folder's",
    (file) => {
      const base = getMirroredCacheBaseDirectory(file);
      const folderCache = path.join(MEDIA_CACHE_DIR, "root", "library", "album");
      expect(isPathInside(folderCache, base)).toBe(true);
      expect(base).not.toBe(folderCache);
      expect(base).not.toBe(getMirroredCacheBaseDirectory("/library/album.jpg"));
      expect(isPathInside(folderCache, getMirroredHLSDirectory(file, "abr"))).toBe(false);
      expect(
        isPathInside(
          path.join(HLS_CACHE_DIR, "root", "library", "album"),
          getMirroredHLSDirectory(file, "abr"),
        ),
      ).toBe(true);
    },
  );

  it("refuses a suffix or subdirectory that would leave the file's cache directory", () => {
    expect(() => getMirroredCachedFilePath("/library/a.jpg", "../../x", "webp")).toThrow(
      PathContainmentError,
    );
    expect(() => getMirroredHLSDirectory("/library/a.mp4", "..")).toThrow(PathContainmentError);
  });
});
