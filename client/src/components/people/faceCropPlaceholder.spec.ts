import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClusterFace } from "../../api/types";

const drawImage = vi.fn();
let tileRequests: string[] = [];

class FakeImage {
  naturalWidth = 480;
  naturalHeight = 320;
  decoding = "";
  set src(value: string) {
    tileRequests.push(value);
  }
  decode() {
    return Promise.resolve();
  }
}

const face = (overrides: Partial<ClusterFace> = {}): ClusterFace =>
  ({
    faceId: 1,
    photo: { path: "/2026/party.heic", name: "party.heic" },
    // A face box centred at (0.5, 0.25), 0.1 x 0.2 of the photo.
    box: { x: 0.5, y: 0.25, width: 0.1, height: 0.2 },
    ...overrides,
  }) as unknown as ClusterFace;

beforeEach(() => {
  vi.resetModules();
  tileRequests = [];
  drawImage.mockClear();
  vi.stubGlobal("Image", FakeImage);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage,
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
    "data:image/jpeg;base64,x",
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("makeFaceCropPlaceholder", () => {
  it("cuts the crop region the server would cut, out of the photo's cached grid tile", async () => {
    const { makeFaceCropPlaceholder } = await import("./faceCropPlaceholder");
    const { faceCropRegion } = await import("../../api/people");
    const { x, y, w, h } = faceCropRegion(face());

    expect(await makeFaceCropPlaceholder(face())).toBe("data:image/jpeg;base64,x");

    expect(tileRequests).toHaveLength(1);
    const tileUrl = new URL(tileRequests[0]);
    expect(tileUrl.searchParams.get("representation")).toBe("webSafe");
    expect(tileUrl.searchParams.get("height")).toBe("320");
    const [, sx, sy, sw, sh] = drawImage.mock.calls[0] as number[];
    expect(sx).toBeCloseTo(x * 480);
    expect(sy).toBeCloseTo(y * 320);
    expect(sw).toBeCloseTo(w * 480);
    expect(sh).toBeCloseTo(h * 320);
  });

  it("fetches each tile once and remembers each placeholder", async () => {
    const { makeFaceCropPlaceholder, peekFaceCropPlaceholder } =
      await import("./faceCropPlaceholder");
    const other = face({
      faceId: 2,
      box: { x: 0.2, y: 0.6, width: 0.1, height: 0.1 },
    } as Partial<ClusterFace>);

    expect(peekFaceCropPlaceholder(face())).toBeNull();
    await makeFaceCropPlaceholder(face());
    await makeFaceCropPlaceholder(other);
    await makeFaceCropPlaceholder(face());

    expect(tileRequests).toHaveLength(1);
    expect(drawImage).toHaveBeenCalledTimes(2);
    expect(peekFaceCropPlaceholder(face())).toBe("data:image/jpeg;base64,x");
  });

  it("makes none for a face found in a video, whose tile is a different frame", async () => {
    const { makeFaceCropPlaceholder } = await import("./faceCropPlaceholder");
    expect(await makeFaceCropPlaceholder(face({ frameTimeMs: 4_500 }))).toBeNull();
    expect(tileRequests).toHaveLength(0);
  });
});
