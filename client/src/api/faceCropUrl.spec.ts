import { buildFaceCropUrl } from "./people";
import { createPhotoItem } from "./photoItem";
import type { ClusterFace } from "./types";

const faceIn = (
  fileName: string,
  mimeType: string,
  frameTimeMs?: number,
): ClusterFace => ({
  photo: createPhotoItem({ folder: "/family/", fileName, mimeType }),
  box: { x: 0.5, y: 0.5, width: 0.2, height: 0.2 },
  faceId: 7,
  ...(frameTimeMs !== undefined ? { frameTimeMs } : {}),
});

describe("buildFaceCropUrl", () => {
  it("crops a photo face without naming a frame", () => {
    const url = new URL(buildFaceCropUrl(faceIn("a.jpg", "image/jpeg")));
    expect(url.searchParams.get("crop")).not.toBeNull();
    expect(url.searchParams.has("t")).toBe(false);
  });

  it("names the frame of a face found in a video", () => {
    const url = new URL(buildFaceCropUrl(faceIn("party.mp4", "video/mp4", 4_500)));
    expect(url.pathname).toBe("/api/files/family/party.mp4");
    expect(url.searchParams.get("t")).toBe("4500");
    expect(url.searchParams.get("crop")).not.toBeNull();
  });

  it("names frame 0 too, rather than treating it as absent", () => {
    const url = new URL(buildFaceCropUrl(faceIn("party.mp4", "video/mp4", 0)));
    expect(url.searchParams.get("t")).toBe("0");
  });
});
