import { act, fireEvent, render, screen } from "@testing-library/react";
import type { PhotoItem } from "../api";
import { ThumbnailTile } from "./ThumbnailTile";

const useSelectionContextMock = vi.fn();

// The shared-observer hook (useNearViewport) creates one IntersectionObserver
// for all tiles rather than one per tile. To keep triggerIntersection() working,
// the fake stores the singleton callback on construction and then exposes
// per-element triggers via the observe() mock.
let fakeCallback: IntersectionObserverCallback | null = null;
const observedElements: Element[] = [];
const originalIntersectionObserver = globalThis.IntersectionObserver;

vi.mock("./selection/SelectionContext", () => ({
  useSelectionContext: () => useSelectionContextMock(),
}));

beforeAll(() => {
  class FakeIntersectionObserver {
    constructor(callback: IntersectionObserverCallback) {
      fakeCallback = callback;
    }

    observe = vi.fn((el: Element) => {
      observedElements.push(el);
    });

    unobserve = vi.fn((el: Element) => {
      const idx = observedElements.indexOf(el);
      if (idx !== -1) observedElements.splice(idx, 1);
    });

    disconnect = vi.fn();
  }

  // @ts-expect-error test override
  globalThis.IntersectionObserver = FakeIntersectionObserver;
});

afterAll(() => {
  globalThis.IntersectionObserver = originalIntersectionObserver;
});

const triggerIntersection = (isIntersecting: boolean) => {
  act(() => {
    if (!fakeCallback) return;
    const entries = observedElements.map(
      (target) => ({ target, isIntersecting }) as unknown as IntersectionObserverEntry,
    );
    if (entries.length > 0) {
      fakeCallback(entries, {} as IntersectionObserver);
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

describe("ThumbnailTile", () => {
  beforeEach(() => {
    useSelectionContextMock.mockReset();
    observedElements.length = 0;
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

  it("shows video preview element while hovered and near viewport for video items", () => {
    const photo = createPhoto({
      path: "a/clip.mp4",
      name: "clip.mp4",
      mediaType: "video",
      videoPreviewUrl: "http://localhost/a/clip-preview.mp4",
    });

    const { container } = render(<ThumbnailTile photo={photo} />);
    const tile = screen.getByRole("button", { name: "clip.mp4" });
    triggerIntersection(true);

    fireEvent.mouseEnter(tile);

    const video = container.querySelector("video");
    expect(video).not.toBeNull();
    expect(video?.getAttribute("src")).toBe("http://localhost/a/clip-preview.mp4");
  });

  it("does not start the video preview when the tile isn't near the viewport", () => {
    const photo = createPhoto({
      path: "a/clip.mp4",
      name: "clip.mp4",
      mediaType: "video",
      videoPreviewUrl: "http://localhost/a/clip-preview.mp4",
    });

    const { container } = render(<ThumbnailTile photo={photo} />);
    const tile = screen.getByRole("button", { name: "clip.mp4" });

    // Never marked "near" — hovering it (e.g. programmatically, or a stray
    // mouseenter before scroll settles) must not spin up the preview.
    fireEvent.mouseEnter(tile);

    expect(container.querySelector("video")).toBeNull();
  });

  it("stops an active hover preview the moment the tile scrolls out of view", () => {
    const photo = createPhoto({
      path: "a/clip.mp4",
      name: "clip.mp4",
      mediaType: "video",
      videoPreviewUrl: "http://localhost/a/clip-preview.mp4",
    });

    const { container } = render(<ThumbnailTile photo={photo} />);
    const tile = screen.getByRole("button", { name: "clip.mp4" });
    triggerIntersection(true);
    fireEvent.mouseEnter(tile);
    expect(container.querySelector("video")).not.toBeNull();

    // Page scrolled the tile away without a mouseleave ever firing — the GPU
    // discipline requirement is that playback stops anyway.
    triggerIntersection(false);
    expect(container.querySelector("video")).toBeNull();
  });

  it("shows the duration overlay on hover and fades it out otherwise", () => {
    const photo = createPhoto({
      path: "a/clip.mp4",
      name: "clip.mp4",
      mediaType: "video",
      metadata: { duration: 125 },
    });

    render(<ThumbnailTile photo={photo} />);
    const tile = screen.getByRole("button", { name: "clip.mp4" });

    const badge = screen.getByText("2:05");
    expect(badge).toHaveStyle({ opacity: "0" });

    fireEvent.mouseEnter(tile);
    expect(badge).toHaveStyle({ opacity: "1" });

    fireEvent.mouseLeave(tile);
    expect(badge).toHaveStyle({ opacity: "0" });
  });

  it("does not show a duration overlay for photos", () => {
    const photo = createPhoto({ metadata: { duration: 125 } });
    render(<ThumbnailTile photo={photo} />);

    expect(screen.queryByText("2:05")).not.toBeInTheDocument();
  });

  it("renders a scrub bar during hover preview that seeks on pointer down", () => {
    const photo = createPhoto({
      path: "a/clip.mp4",
      name: "clip.mp4",
      mediaType: "video",
      videoPreviewUrl: "http://localhost/a/clip-preview.mp4",
      metadata: { duration: 100 },
    });

    const { container } = render(<ThumbnailTile photo={photo} />);
    const tile = screen.getByRole("button", { name: "clip.mp4" });
    triggerIntersection(true);
    fireEvent.mouseEnter(tile);

    const video = container.querySelector("video") as HTMLVideoElement;
    expect(video).not.toBeNull();
    Object.defineProperty(video, "duration", { value: 100, configurable: true });

    const scrubBar = container.querySelector('[class*="scrubBar"]') as HTMLElement;
    expect(scrubBar).not.toBeNull();
    scrubBar.setPointerCapture = vi.fn();
    Object.defineProperty(scrubBar, "getBoundingClientRect", {
      value: () => ({ left: 0, width: 100 }),
      configurable: true,
    });

    fireEvent.pointerDown(scrubBar, { clientX: 40, pointerId: 1 });

    expect(video.currentTime).toBe(40);
  });

  it("does not open the fullscreen viewer when interacting with the scrub bar", () => {
    const setSelected = vi.fn();
    useSelectionContextMock.mockReturnValue({
      setSelected,
      selectionMode: false,
      checkedPaths: new Set<string>(),
      enterSelectionMode: vi.fn(),
      toggleChecked: vi.fn(),
    });

    const photo = createPhoto({
      path: "a/clip.mp4",
      name: "clip.mp4",
      mediaType: "video",
      videoPreviewUrl: "http://localhost/a/clip-preview.mp4",
      metadata: { duration: 100 },
    });

    const { container } = render(<ThumbnailTile photo={photo} />);
    const tile = screen.getByRole("button", { name: "clip.mp4" });
    triggerIntersection(true);
    fireEvent.mouseEnter(tile);

    const scrubBar = container.querySelector('[class*="scrubBar"]') as HTMLElement;
    fireEvent.click(scrubBar);

    expect(setSelected).not.toHaveBeenCalled();
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

    triggerIntersection(false);
    expect(image).toHaveAttribute("loading", "lazy");
    expect(image).toHaveAttribute("fetchpriority", "low");
    expect(image).not.toHaveAttribute("src");
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

describe("ThumbnailTile on a coarse (touch) pointer", () => {
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    useSelectionContextMock.mockReset();
    observedElements.length = 0;
    useSelectionContextMock.mockReturnValue({
      setSelected: vi.fn(),
      selectionMode: false,
      checkedPaths: new Set<string>(),
      enterSelectionMode: vi.fn(),
      toggleChecked: vi.fn(),
    });
    vi.useFakeTimers();
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query === "(pointer: coarse)",
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: originalMatchMedia,
    });
  });

  const createVideoPhoto = (): PhotoItem => ({
    path: "a/clip.mp4",
    name: "clip.mp4",
    mediaType: "video",
    originalUrl: "http://localhost/a/clip.mp4",
    thumbnailUrl: "http://localhost/a/clip.mp4",
    previewUrl: "http://localhost/a/clip.mp4",
    fullUrl: "http://localhost/a/clip.mp4",
    videoPreviewUrl: "http://localhost/a/clip-preview.mp4",
    metadata: { duration: 65 },
  });

  it("starts the preview after a dwell delay instead of on hover", () => {
    const photo = createVideoPhoto();
    const { container } = render(<ThumbnailTile photo={photo} />);
    const tile = screen.getByRole("button", { name: "clip.mp4" });
    triggerIntersection(true);

    fireEvent.pointerDown(tile);
    expect(container.querySelector("video")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(349);
    });
    expect(container.querySelector("video")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(container.querySelector("video")).not.toBeNull();
  });

  it("stops the preview as soon as the touch releases", () => {
    const photo = createVideoPhoto();
    const { container } = render(<ThumbnailTile photo={photo} />);
    const tile = screen.getByRole("button", { name: "clip.mp4" });
    triggerIntersection(true);

    fireEvent.pointerDown(tile);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(container.querySelector("video")).not.toBeNull();

    fireEvent.pointerUp(tile);
    expect(container.querySelector("video")).toBeNull();
  });

  it("also reveals the duration overlay once the dwell fires", () => {
    const photo = createVideoPhoto();
    render(<ThumbnailTile photo={photo} />);
    const tile = screen.getByRole("button", { name: "clip.mp4" });
    triggerIntersection(true);

    const badge = screen.getByText("1:05");
    expect(badge).toHaveStyle({ opacity: "0" });

    fireEvent.pointerDown(tile);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(badge).toHaveStyle({ opacity: "1" });
  });
});
