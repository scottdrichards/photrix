import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { faceCropRegion } from "../../../shared/face-crop/src/index.ts";

// The cache root is resolved from CACHE_DIR at import time.
let mod: typeof import("./faceCropBackfill.ts");
let convert: typeof import("./convertImage.ts");
let video: typeof import("../videoProcessing/videoUtils.ts");
let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "photrix-face-crops-"));
  process.env.CACHE_DIR = root;
  mod = await import("./faceCropBackfill.ts");
  convert = await import("./convertImage.ts");
  video = await import("../videoProcessing/videoUtils.ts");
});

afterAll(() => {
  delete process.env.CACHE_DIR;
});

const face = (overrides: Record<string, unknown> = {}) => ({
  path: "/people/a.jpg",
  fileName: "a.jpg",
  box: { x: 0.4234567891, y: 0.3141592653, width: 0.0871828182, height: 0.1618033988 },
  mimeType: "image/jpeg" as string | null,
  dimensionWidth: null,
  dimensionHeight: null,
  regions: null,
  faceId: 7,
  ...overrides,
});

describe("faceCropRegion", () => {
  it("grows the face box by the margin and keeps it inside the photo", () => {
    const centred = faceCropRegion({ x: 0.5, y: 0.5, width: 0.1, height: 0.2 });
    expect(centred.w).toBeCloseTo(0.22, 10);
    expect(centred.h).toBeCloseTo(0.44, 10);
    expect(centred.x).toBeCloseTo(0.39, 10);
    expect(centred.y).toBeCloseTo(0.28, 10);
    // A face in the corner: the region is pushed back inside.
    const corner = faceCropRegion({ x: 0.98, y: 0.01, width: 0.2, height: 0.2 });
    expect(corner.x + corner.w).toBeLessThanOrEqual(1);
    expect(corner.y).toBe(0);
    // A face bigger than the photo allows: the whole photo.
    expect(faceCropRegion({ x: 0.5, y: 0.5, width: 0.9, height: 0.9 })).toEqual({
      x: 0,
      y: 0,
      w: 1,
      h: 1,
    });
  });
});

describe("planFaceCropWork", () => {
  it("looks for the crop where a request for the client's URL would put it", () => {
    // The client writes the region into the URL as plain numbers; the request
    // handler parses them back. The crop made ahead of time is only found again
    // if both land on the same cache file.
    for (const box of [
      face().box,
      { x: 0.98, y: 0.01, width: 0.2, height: 0.2 },
      { x: 1 / 3, y: 2 / 3, width: 1 / 7, height: 1 / 9 },
    ]) {
      const region = faceCropRegion(box);
      const [x, y, width, height] = `${region.x},${region.y},${region.w},${region.h}`
        .split(",")
        .map((part) => Number.parseFloat(part));
      const fromUrl = convert.getImageCropCachePath("/library/a.jpg", { x, y, width, height }, 320);
      const ahead = convert.getImageCropCachePath(
        "/library/a.jpg",
        { x: region.x, y: region.y, width: region.w, height: region.h },
        320,
      );
      expect(ahead).toBe(fromUrl);
    }
  });

  it("plans a decode for an image face that has no crop yet", async () => {
    const work = await mod.planFaceCropWork("/library", face());
    expect(work).toMatchObject({ readBytes: 5 * 1024 * 1024 });
  });

  it("has nothing to cut for a video face with no frame, and a frame crop otherwise", async () => {
    const noFrame = face({ path: "/clips/b.mp4", fileName: "b.mp4", mimeType: "video/mp4" });
    expect(await mod.planFaceCropWork("/library", noFrame)).toBeNull();

    const withFrame = { ...noFrame, frameTimeMs: 1500 };
    expect(await mod.planFaceCropWork("/library", withFrame)).not.toBeNull();
    const region = faceCropRegion(withFrame.box);
    expect(
      video.getVideoFrameCropCachePath(
        "/library/clips/b.mp4",
        1500,
        { x: region.x, y: region.y, width: region.w, height: region.h },
        320,
      ),
    ).toMatch(/frame\.1500\.320\.crop_/);
  });
});
