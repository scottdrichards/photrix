import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PhotoItem, VideoNegotiationResult } from "../api";
import { ThumbnailTile } from "./ThumbnailTile";
import { __resetTilePlaybackCoordinatorForTests } from "./tileMedia/tilePlaybackCoordinator";
import { clearLiveOpenIntent, consumeLiveOpenIntent } from "./tileMedia/liveOpenIntent";
import { __resetHoverIntentForTests } from "./ThumbnailTile.hoverIntent";
import {
  MAX_CONCURRENT_LOADS,
  resetSharpThumbnailQueue,
  sharpThumbnailQueueStats,
} from "./tileMedia/sharpThumbnailQueue";

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
    resetSharpThumbnailQueue();
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

  describe("stack controls", () => {
    it("renders the stack badge + kebab for a collapsed representative, and neither opens the photo", () => {
      const setSelected = vi.fn();
      const onToggleStack = vi.fn();
      const onOpenStackActions = vi.fn();
      useSelectionContextMock.mockReturnValue({
        setSelected,
        selectionMode: false,
        checkedPaths: new Set<string>(),
        enterSelectionMode: vi.fn(),
        toggleChecked: vi.fn(),
      });

      render(
        <ThumbnailTile
          photo={createPhoto()}
          stackCount={3}
          onToggleStack={onToggleStack}
          onOpenStackActions={onOpenStackActions}
        />,
      );

      const badge = screen.getByRole("button", {
        name: "3 photos of this moment — show separately",
      });
      expect(badge).toHaveTextContent("3");
      fireEvent.click(badge);
      expect(onToggleStack).toHaveBeenCalledTimes(1);

      const kebab = screen.getByRole("button", { name: /more stack options/i });
      fireEvent.click(kebab);
      expect(onOpenStackActions).toHaveBeenCalledTimes(1);

      // Neither control is the tile's own click target — clicking them must
      // not also open the fullscreen viewer for the photo.
      expect(setSelected).not.toHaveBeenCalled();
    });

    it("supports keyboard activation (Enter and Space) on the stack badge", () => {
      const onToggleStack = vi.fn();
      useSelectionContextMock.mockReturnValue({
        setSelected: vi.fn(),
        selectionMode: false,
        checkedPaths: new Set<string>(),
        enterSelectionMode: vi.fn(),
        toggleChecked: vi.fn(),
      });

      render(
        <ThumbnailTile photo={createPhoto()} stackCount={2} onToggleStack={onToggleStack} />,
      );

      const badge = screen.getByRole("button", {
        name: "2 photos of this moment — show separately",
      });
      fireEvent.keyDown(badge, { key: "Enter" });
      fireEvent.keyDown(badge, { key: " " });
      expect(onToggleStack).toHaveBeenCalledTimes(2);

      // An unrelated key must not trigger it.
      fireEvent.keyDown(badge, { key: "Tab" });
      expect(onToggleStack).toHaveBeenCalledTimes(2);
    });

    it("shows the stack count only once it's greater than 2", () => {
      useSelectionContextMock.mockReturnValue({
        setSelected: vi.fn(),
        selectionMode: false,
        checkedPaths: new Set<string>(),
        enterSelectionMode: vi.fn(),
        toggleChecked: vi.fn(),
      });

      const { rerender } = render(<ThumbnailTile photo={createPhoto()} stackCount={2} />);
      const twoStackBadge = screen.getByRole("button", {
        name: "2 photos of this moment — show separately",
      });
      expect(twoStackBadge).not.toHaveTextContent("2");

      rerender(<ThumbnailTile photo={createPhoto()} stackCount={3} />);
      const threeStackBadge = screen.getByRole("button", {
        name: "3 photos of this moment — show separately",
      });
      expect(threeStackBadge).toHaveTextContent("3");
    });

    it("puts the expand trigger at the bottom-right of the tile, not the top-right kebab corner", () => {
      useSelectionContextMock.mockReturnValue({
        setSelected: vi.fn(),
        selectionMode: false,
        checkedPaths: new Set<string>(),
        enterSelectionMode: vi.fn(),
        toggleChecked: vi.fn(),
      });

      render(<ThumbnailTile photo={createPhoto()} stackCount={3} onOpenStackActions={vi.fn()} />);

      const badge = screen.getByRole("button", {
        name: "3 photos of this moment — show separately",
      });
      const kebab = screen.getByRole("button", { name: /more stack options/i });
      // The expand badge must not share the kebab's top-right container — see
      // feedback #81, which specifically asked to stop overloading that
      // corner with the primary action.
      expect(badge.parentElement).not.toBe(kebab.parentElement);
    });

    it("renders a restack badge (no count shown) instead of the stack badge when restackCount is set", () => {
      const onToggleStack = vi.fn();
      useSelectionContextMock.mockReturnValue({
        setSelected: vi.fn(),
        selectionMode: false,
        checkedPaths: new Set<string>(),
        enterSelectionMode: vi.fn(),
        toggleChecked: vi.fn(),
      });

      render(
        <ThumbnailTile
          photo={createPhoto()}
          restackCount={3}
          onToggleStack={onToggleStack}
        />,
      );

      expect(
        screen.queryByRole("button", { name: /photos of this moment — show separately/ }),
      ).not.toBeInTheDocument();
      const restackBadge = screen.getByRole("button", { name: "Restack these 3 photos" });
      fireEvent.click(restackBadge);
      expect(onToggleStack).toHaveBeenCalledTimes(1);
    });

    it("renders no stack controls for an ordinary tile", () => {
      useSelectionContextMock.mockReturnValue({
        setSelected: vi.fn(),
        selectionMode: false,
        checkedPaths: new Set<string>(),
        enterSelectionMode: vi.fn(),
        toggleChecked: vi.fn(),
      });

      render(<ThumbnailTile photo={createPhoto()} />);

      expect(screen.queryByText(/more stack options/i)).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /photos of this moment/ }),
      ).not.toBeInTheDocument();
    });

    it("applies view-transition-name to the root tile when provided, for View Transitions matching across a toggle", () => {
      useSelectionContextMock.mockReturnValue({
        setSelected: vi.fn(),
        selectionMode: false,
        checkedPaths: new Set<string>(),
        enterSelectionMode: vi.fn(),
        toggleChecked: vi.fn(),
      });

      render(
        <ThumbnailTile
          photo={createPhoto()}
          stackCount={2}
          viewTransitionName="photrix-tile-a-1-jpg"
        />,
      );

      const tile = screen.getByRole("button", { name: "1.jpg" });
      expect(tile.style.viewTransitionName).toBe("photrix-tile-a-1-jpg");
    });

    it("renders a peek thumbnail per preview path (capped at 2) for a collapsed representative", () => {
      useSelectionContextMock.mockReturnValue({
        setSelected: vi.fn(),
        selectionMode: false,
        checkedPaths: new Set<string>(),
        enterSelectionMode: vi.fn(),
        toggleChecked: vi.fn(),
      });

      render(
        <ThumbnailTile
          photo={createPhoto({
            metadata: {
              momentClusterPreviewPaths: ["a/2.jpg", "a/3.jpg", "a/4.jpg"],
            },
          })}
          stackCount={4}
        />,
      );

      // alt="" — these are decorative (the badge already carries the
      // accessible "N photos" label) — so query by src instead of role/name.
      const peeks = document.querySelectorAll('img[alt=""]');
      expect(peeks).toHaveLength(2);
      expect((peeks[0] as HTMLImageElement).src).toContain("a/2.jpg");
      expect((peeks[1] as HTMLImageElement).src).toContain("a/3.jpg");
    });

    it("renders no peek thumbnails for an unstacked member, even if the photo carries preview-path metadata", () => {
      useSelectionContextMock.mockReturnValue({
        setSelected: vi.fn(),
        selectionMode: false,
        checkedPaths: new Set<string>(),
        enterSelectionMode: vi.fn(),
        toggleChecked: vi.fn(),
      });

      render(
        <ThumbnailTile
          photo={createPhoto({
            metadata: { momentClusterPreviewPaths: ["a/2.jpg"] },
          })}
          restackCount={3}
        />,
      );

      expect(document.querySelectorAll('img[alt=""]')).toHaveLength(0);
    });
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

  it("releases the sharp-thumbnail queue slot for a video thumbnail resolved from cache", () => {
    // Simulates an image the browser already had cached: `complete`/`naturalWidth`
    // read true before React's onLoad listener ever attaches, so useImageFade's
    // mount effect (not the `load` event) is what resolves it. Regression for the
    // "video thumbnails aren't showing" report: the gate's release() used to be
    // wired only to the JSX onLoad handler, so a cache-resolved load never freed
    // its slot in sharpThumbnailQueue — six of those permanently pinned the shared
    // queue at capacity and every tile after sat queued forever, which showed up
    // worst on video tiles since (unlike photos) they have no micro-thumbnail
    // fallback to display while starved.
    const completeDescriptor = Object.getOwnPropertyDescriptor(
      HTMLImageElement.prototype,
      "complete",
    );
    const naturalWidthDescriptor = Object.getOwnPropertyDescriptor(
      HTMLImageElement.prototype,
      "naturalWidth",
    );
    Object.defineProperty(HTMLImageElement.prototype, "complete", {
      configurable: true,
      get: () => true,
    });
    Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", {
      configurable: true,
      get: () => 100,
    });

    try {
      // Fill every concurrency slot with videos that resolve via the cache-hit path.
      for (let i = 0; i < MAX_CONCURRENT_LOADS; i += 1) {
        const filler = createVideo({
          path: `a/filler-${i}.mp4`,
          name: `filler-${i}.mp4`,
          thumbnailUrl: `http://localhost/a/filler-${i}.jpg`,
        });
        render(<ThumbnailTile photo={filler} />);
      }
      triggerIntersection(true);

      // A tile past the concurrency limit must still be admitted immediately: if
      // any of the cache-resolved loads above leaked its slot, this one would be
      // left permanently queued (no src) instead.
      const overflow = createVideo({
        path: "a/overflow.mp4",
        name: "overflow.mp4",
        thumbnailUrl: "http://localhost/a/overflow.jpg",
      });
      render(<ThumbnailTile photo={overflow} />);
      triggerIntersection(true);

      expect(screen.getByRole("img", { name: "overflow.mp4" })).toHaveAttribute(
        "src",
        "http://localhost/a/overflow.jpg",
      );
    } finally {
      if (completeDescriptor) {
        Object.defineProperty(HTMLImageElement.prototype, "complete", completeDescriptor);
      }
      if (naturalWidthDescriptor) {
        Object.defineProperty(
          HTMLImageElement.prototype,
          "naturalWidth",
          naturalWidthDescriptor,
        );
      }
      resetSharpThumbnailQueue();
    }
  });

  it("spends no sharp-thumbnail queue slot on tiles that render no gated image", () => {
    // Regression for "many videos never even request a thumbnail". The gated
    // video-thumbnail URL is only ever rendered by the video branch's <img>, so
    // only that <img> can settle and release the slot. Photo tiles (and non-image
    // tiles) used to take a slot for it too — one nothing could ever free, since
    // no element carried the URL to load or error. Six of those pinned the shared
    // queue at capacity permanently, after which no tile downstream was admitted
    // and video tiles issued no request at all. Photos masked it: their micro
    // thumbnail bypasses the queue entirely.
    for (let i = 0; i < MAX_CONCURRENT_LOADS; i += 1) {
      render(
        <ThumbnailTile
          photo={createPhoto({
            path: `a/photo-${i}.jpg`,
            name: `photo-${i}.jpg`,
            thumbnailUrl: `http://localhost/a/photo-${i}.jpg`,
            microThumbnailUrl: `http://localhost/a/photo-${i}.micro`,
          })}
        />,
      );
    }
    render(
      <ThumbnailTile
        photo={createPhoto({
          path: "a/document.pdf",
          name: "document.pdf",
          metadata: { mimeType: "application/pdf" },
        })}
      />,
    );
    render(
      <ThumbnailTile
        photo={createVideo({
          path: "a/late.mp4",
          name: "late.mp4",
          thumbnailUrl: "http://localhost/a/late.jpg",
        })}
      />,
    );

    triggerPrefetchOnly();

    expect(screen.getByRole("img", { name: "late.mp4" })).toHaveAttribute(
      "src",
      "http://localhost/a/late.jpg",
    );
    // The video tile is the only thing in the band that owns a gated image.
    expect(sharpThumbnailQueueStats()).toEqual({ activeLoads: 1, waitingCount: 0 });
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

  it("hides the match-reason source badges by default, shows them via showMatchReasons (feedback #112)", () => {
    const photo = createPhoto({ searchSources: ["image", "transcript"] });

    const { rerender } = render(<ThumbnailTile photo={photo} />);
    expect(screen.queryByLabelText(/Matched by:/)).not.toBeInTheDocument();

    rerender(<ThumbnailTile photo={photo} showMatchReasons />);
    expect(
      screen.getByLabelText(
        "Matched by: Matched on image content, Matched in transcript",
      ),
    ).toBeInTheDocument();
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
