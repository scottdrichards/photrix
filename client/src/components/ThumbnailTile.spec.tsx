import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PhotoItem, VideoNegotiationResult } from "../api";
import { ThumbnailTile } from "./ThumbnailTile";
import { __resetTilePlaybackCoordinatorForTests } from "./tileMedia/tilePlaybackCoordinator";
import { clearLiveOpenIntent, consumeLiveOpenIntent } from "./tileMedia/liveOpenIntent";
import { __resetHoverIntentForTests } from "./ThumbnailTile.hoverIntent";

const useSelectionContextMock = vi.fn();
const negotiateVideoPlaybackMock = vi.fn<() => Promise<VideoNegotiationResult>>();

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  negotiateVideoPlayback: () => negotiateVideoPlaybackMock(),
}));

vi.mock("../videoPlaybackProfile", () => ({
  probeVideoPlaybackProfile: () =>
    Promise.resolve({ bandwidthMbps: 100, hevcSupported: true }),
}));

// useNearViewport creates one shared IntersectionObserver *per band* (a wide
// prefetch band and a narrow close band) rather than one per tile, so the fake
// tracks instances individually and identifies each band by its rootMargin —
// the prefetch band is by definition the wider of the two.
type FakeObserverInstance = {
  callback: IntersectionObserverCallback;
  margin: number;
  elements: Element[];
};

const fakeObservers: FakeObserverInstance[] = [];
const originalIntersectionObserver = globalThis.IntersectionObserver;

vi.mock("./selection/SelectionContext", () => ({
  useSelectionContext: () => useSelectionContextMock(),
}));

beforeAll(() => {
  class FakeIntersectionObserver {
    private instance: FakeObserverInstance;

    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      this.instance = {
        callback,
        margin: Number.parseInt(String(options?.rootMargin ?? "0"), 10) || 0,
        elements: [],
      };
      fakeObservers.push(this.instance);
    }

    observe = vi.fn((el: Element) => {
      this.instance.elements.push(el);
    });

    unobserve = vi.fn((el: Element) => {
      const idx = this.instance.elements.indexOf(el);
      if (idx !== -1) this.instance.elements.splice(idx, 1);
    });

    disconnect = vi.fn(() => {
      this.instance.elements.length = 0;
    });
  }

  // @ts-expect-error test override
  globalThis.IntersectionObserver = FakeIntersectionObserver;
});

afterAll(() => {
  globalThis.IntersectionObserver = originalIntersectionObserver;
});

const notify = (instance: FakeObserverInstance, isIntersecting: boolean) => {
  const entries = instance.elements.map(
    (target) => ({ target, isIntersecting }) as unknown as IntersectionObserverEntry,
  );
  if (entries.length > 0) {
    instance.callback(entries, {} as IntersectionObserver);
  }
};

/** Scroll every tile fully into view (both bands). */
const triggerIntersection = (isIntersecting: boolean) => {
  act(() => {
    for (const instance of fakeObservers) notify(instance, isIntersecting);
  });
};

/**
 * Put tiles in the wide prefetch band but not the narrow close band — what a
 * tile a screenful ahead of the viewport sees.
 */
const triggerPrefetchOnly = () => {
  const widest = [...fakeObservers].sort((a, b) => b.margin - a.margin)[0];
  act(() => {
    for (const instance of fakeObservers) {
      notify(instance, instance === widest);
    }
  });
};

const createPhoto = (overrides: Partial<PhotoItem> = {}): PhotoItem => ({
  path: "a/1.jpg",
  name: "1.jpg",
  mediaType: "photo",
  originalUrl: "http://localhost/a/1.jpg",
  thumbnailUrl: "http://localhost/a/1.jpg",
  previewUrl: "http://localhost/a/1.jpg",
  fullUrl: "http://localhost/a/1.jpg",
  ...overrides,
});

const createVideo = (overrides: Partial<PhotoItem> = {}): PhotoItem =>
  createPhoto({
    path: "a/clip.mp4",
    name: "clip.mp4",
    mediaType: "video",
    metadata: { mimeType: "video/mp4", duration: 95 },
    ...overrides,
  });

/** Hover a tile and let the dwell delay elapse so a preview may start. */
const hoverAndDwell = (tile: HTMLElement) => {
  fireEvent.mouseEnter(tile);
  act(() => {
    vi.advanceTimersByTime(1100);
  });
};

describe("ThumbnailTile", () => {
  beforeEach(() => {
    useSelectionContextMock.mockReset();
    negotiateVideoPlaybackMock.mockReset();
    negotiateVideoPlaybackMock.mockResolvedValue({
      mode: "direct",
      url: "http://localhost/a/clip.mp4",
      reason: "preview",
      previewMaxSeconds: 6,
    });
    __resetTilePlaybackCoordinatorForTests();
    clearLiveOpenIntent();
    __resetHoverIntentForTests();
    for (const instance of fakeObservers) instance.elements.length = 0;
    useSelectionContextMock.mockReturnValue({
      items: [],
      selected: null,
      setSelected: vi.fn(),
      setItems: vi.fn(),
      selectNext: vi.fn(),
      selectPrevious: vi.fn(),
      selectionMode: false,
      checkedPaths: new Set<string>(),
      enterSelectionMode: vi.fn(),
      exitSelectionMode: vi.fn(),
      toggleChecked: vi.fn(),
    });
  });

  it("opens photo when clicked in normal mode", () => {
    const setSelected = vi.fn();
    useSelectionContextMock.mockReturnValue({
      setSelected,
      selectionMode: false,
      checkedPaths: new Set<string>(),
      enterSelectionMode: vi.fn(),
      toggleChecked: vi.fn(),
    });

    const photo = createPhoto();
    render(<ThumbnailTile photo={photo} />);

    fireEvent.click(screen.getByRole("button", { name: "1.jpg" }));

    expect(setSelected).toHaveBeenCalledWith(photo);
  });

  describe("video hover preview", () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("does not start anything on a momentary hover", () => {
      const { container } = render(<ThumbnailTile photo={createVideo()} />);
      triggerIntersection(true);

      fireEvent.mouseEnter(screen.getByRole("button", { name: "clip.mp4" }));
      act(() => {
        vi.advanceTimersByTime(100);
      });

      expect(container.querySelector("video")).toBeNull();
      expect(negotiateVideoPlaybackMock).not.toHaveBeenCalled();
    });

    it("negotiates a preview-mode source once the hover dwell elapses", async () => {
      const { container } = render(<ThumbnailTile photo={createVideo()} />);
      triggerIntersection(true);

      hoverAndDwell(screen.getByRole("button", { name: "clip.mp4" }));

      expect(container.querySelector("video")).not.toBeNull();
      await waitFor(() =>
        expect(container.querySelector("video")?.getAttribute("src")).toBe(
          "http://localhost/a/clip.mp4",
        ),
      );
    });

    it("coasts to a stop and fades back to the thumbnail when the pointer leaves", async () => {
      const { container } = render(<ThumbnailTile photo={createVideo()} />);
      triggerIntersection(true);
      const tile = screen.getByRole("button", { name: "clip.mp4" });

      hoverAndDwell(tile);
      await waitFor(() => expect(container.querySelector("video")).not.toBeNull());

      fireEvent.mouseLeave(tile);

      // Still there right after leaving — it plays out the coast-down and fade
      // rather than cutting off mid-frame.
      expect(container.querySelector("video")).not.toBeNull();

      await waitFor(() => expect(container.querySelector("video")).toBeNull(), {
        timeout: 3000,
      });
    });

    it("tears the player down when the tile scrolls out of range", async () => {
      const { container } = render(<ThumbnailTile photo={createVideo()} />);
      triggerIntersection(true);

      hoverAndDwell(screen.getByRole("button", { name: "clip.mp4" }));
      await waitFor(() => expect(container.querySelector("video")).not.toBeNull());

      triggerIntersection(false);

      expect(container.querySelector("video")).toBeNull();
    });

    it("shows a scrub bar while the preview plays and lets a drag seek without opening the tile", async () => {
      const onClick = vi.fn();
      const { container } = render(<ThumbnailTile photo={createVideo()} />);
      triggerIntersection(true);
      const tile = screen.getByRole("button", { name: "clip.mp4" });
      tile.addEventListener("click", onClick);

      hoverAndDwell(tile);
      await waitFor(() => expect(container.querySelector("video")).not.toBeNull());

      const video = container.querySelector("video") as HTMLVideoElement;
      Object.defineProperty(video, "duration", { value: 95, configurable: true });
      Object.defineProperty(video, "currentTime", { value: 0, writable: true, configurable: true });

      const bar = container.querySelector('[class*="scrubBar"]');
      expect(bar).not.toBeNull();

      fireEvent.pointerDown(bar as Element, { clientX: 50 });
      fireEvent.pointerUp(bar as Element, { clientX: 50 });

      // Dragging the scrub bar seeks the underlying element rather than
      // toggling selection or opening the fullscreen viewer.
      expect(onClick).not.toHaveBeenCalled();
    });

    it("shows no preview when the server declines to transcode for one", async () => {
      negotiateVideoPlaybackMock.mockResolvedValue({
        mode: "error",
        reason: "No preview without a fresh transcode",
      });
      const { container } = render(<ThumbnailTile photo={createVideo()} />);
      triggerIntersection(true);

      hoverAndDwell(screen.getByRole("button", { name: "clip.mp4" }));

      await waitFor(() => expect(negotiateVideoPlaybackMock).toHaveBeenCalled());
      await waitFor(() =>
        expect(container.querySelector("video")?.getAttribute("src")).toBeFalsy(),
      );
      expect(screen.getByRole("img", { name: "clip.mp4" })).toBeInTheDocument();
    });

    it("reveals the video duration on dwell and hides it again on leave", () => {
      render(<ThumbnailTile photo={createVideo()} />);
      triggerIntersection(true);
      const tile = screen.getByRole("button", { name: "clip.mp4" });
      const badge = screen.getByLabelText("Duration 1:35");

      expect(badge.className).not.toMatch(/metaVisible/);

      hoverAndDwell(tile);
      expect(badge.className).toMatch(/metaVisible/);

      fireEvent.mouseLeave(tile);
      expect(badge.className).not.toMatch(/metaVisible/);
    });

    it("has no duration overlay for photos", () => {
      render(<ThumbnailTile photo={createPhoto()} />);
      expect(screen.queryByLabelText(/^Duration/)).not.toBeInTheDocument();
    });
  });

  it("fades image in when it finishes loading", () => {
    const photo = createPhoto();
    render(<ThumbnailTile photo={photo} />);
    triggerIntersection(true);

    const image = screen.getByRole("img", { name: "1.jpg" });
    expect(image).toHaveStyle({ opacity: "0" });

    fireEvent.load(image);

    expect(image).toHaveStyle({ opacity: "1" });
  });

  it("shows live photo badge for photos with livePhotoUrl", () => {
    const photo = createPhoto({ livePhotoUrl: "http://localhost/a/1.MOV" });
    render(<ThumbnailTile photo={photo} />);

    expect(screen.getByLabelText("Live photo")).toBeInTheDocument();
  });

  it("plays the motion clip while the live badge is hovered and stops on leave", () => {
    const photo = createPhoto({ livePhotoUrl: "http://localhost/a/1.MOV" });
    const { container } = render(<ThumbnailTile photo={photo} />);
    triggerIntersection(true);
    const badge = screen.getByLabelText("Live photo");

    fireEvent.mouseEnter(badge);
    expect(container.querySelector("video")?.getAttribute("src")).toBe(
      "http://localhost/a/1.MOV",
    );

    fireEvent.mouseLeave(badge);
    // Playback stops immediately; the element lingers only for its fade-out.
    expect(
      container.querySelector("video")?.className.includes("motionLayerVisible"),
    ).not.toBe(true);
  });

  it("opens the paired clip as a video when clicked from the live badge", () => {
    const setSelected = vi.fn();
    useSelectionContextMock.mockReturnValue({
      setSelected,
      selectionMode: false,
      checkedPaths: new Set<string>(),
      enterSelectionMode: vi.fn(),
      toggleChecked: vi.fn(),
    });
    const photo = createPhoto({ livePhotoUrl: "http://localhost/a/1.MOV" });
    render(<ThumbnailTile photo={photo} />);

    fireEvent.mouseEnter(screen.getByLabelText("Live photo"));
    fireEvent.click(screen.getByRole("button", { name: "1.jpg" }));

    expect(setSelected).toHaveBeenCalledWith(photo);
    expect(consumeLiveOpenIntent(photo.path)).toBe(true);
  });

  it("does not flag a live open for an ordinary tile click", () => {
    const photo = createPhoto({ livePhotoUrl: "http://localhost/a/1.MOV" });
    render(<ThumbnailTile photo={photo} />);

    fireEvent.click(screen.getByRole("button", { name: "1.jpg" }));

    expect(consumeLiveOpenIntent(photo.path)).toBe(false);
  });

  it("does not show live photo badge for photos without livePhotoUrl", () => {
    const photo = createPhoto();
    render(<ThumbnailTile photo={photo} />);

    expect(screen.queryByLabelText("Live photo")).not.toBeInTheDocument();
  });

  it("prioritizes in-view thumbnails over offscreen thumbnails", () => {
    const photo = createPhoto();
    render(<ThumbnailTile photo={photo} />);

    const image = screen.getByRole("img", { name: "1.jpg" });
    expect(image).toHaveAttribute("loading", "lazy");
    expect(image).toHaveAttribute("fetchpriority", "low");
    expect(image).not.toHaveAttribute("src");

    triggerIntersection(true);
    expect(image).toHaveAttribute("loading", "eager");
    expect(image).toHaveAttribute("fetchpriority", "high");
    expect(image).toHaveAttribute("src", "http://localhost/a/1.jpg");
  });

  it("keeps a loaded thumbnail's src after it scrolls away", () => {
    render(<ThumbnailTile photo={createPhoto()} />);
    const image = screen.getByRole("img", { name: "1.jpg" });

    triggerIntersection(true);
    expect(image).toHaveAttribute("src", "http://localhost/a/1.jpg");

    triggerIntersection(false);

    // Dropping the src makes the browser discard the image *and* its decoded
    // bitmap, so scrolling back re-fetches and re-decodes a whole screenful at
    // once. Only the priority hint is allowed to relax.
    expect(image).toHaveAttribute("src", "http://localhost/a/1.jpg");
    expect(image).toHaveAttribute("fetchpriority", "low");
  });

  it("loads only the micro thumbnail for tiles in the prefetch band", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const photo = createPhoto({ microThumbnailUrl: "http://localhost/a/1.micro" });
      const { container } = render(<ThumbnailTile photo={photo} />);

      triggerPrefetchOnly();
      act(() => {
        vi.advanceTimersByTime(1000);
      });

      const images = [...container.querySelectorAll("img")];
      expect(images.map((img) => img.getAttribute("src"))).toEqual([
        "http://localhost/a/1.micro",
        null,
      ]);

      // Reaching the close band and settling there is what earns the sharp 320.
      triggerIntersection(true);
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(images[1]).toHaveAttribute("src", "http://localhost/a/1.jpg");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a hover that the page scrolling under the cursor produced", () => {
    const photo = createPhoto({ microThumbnailUrl: "http://localhost/a/1.micro" });
    const { container } = render(<ThumbnailTile photo={photo} />);
    triggerPrefetchOnly();

    fireEvent.scroll(window);
    fireEvent.mouseEnter(screen.getByRole("button", { name: "1.jpg" }));

    // No hover means no sharp upgrade: a wheel scroll must not drag a
    // full-resolution fetch across every tile it passes.
    expect(container.querySelectorAll("img")[1]).not.toHaveAttribute("src");

    // A real pointer move ends the suppression immediately.
    fireEvent.pointerMove(window, { clientX: 40, clientY: 80 });
    fireEvent.mouseEnter(screen.getByRole("button", { name: "1.jpg" }));

    expect(container.querySelectorAll("img")[1]).toHaveAttribute(
      "src",
      "http://localhost/a/1.jpg",
    );
  });

  it("displays filename for non-image files", () => {
    const photo = createPhoto({
      path: "a/document.pdf",
      name: "document.pdf",
      metadata: { mimeType: "application/pdf" },
    });
    render(<ThumbnailTile photo={photo} />);

    expect(screen.getByText("document.pdf")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
