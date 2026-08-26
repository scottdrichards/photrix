import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import type { PhotoItem } from "../api";
import { FullscreenViewer } from "./FullscreenViewer";
import css from "./FullscreenViewer.module.css";
import swipeCss from "./SwipePhotoViewer.module.css";

const probeVideoPlaybackProfileMock = vi.fn().mockResolvedValue({
  bandwidthMbps: 20,
  hevcSupported: true,
});

const negotiateVideoPlaybackMock = vi.fn();
const logClientEventMock = vi.fn();
const createClientOperationIdMock = vi.fn(() => "client-op-1");

const {
  fetchPhotoCaptionMock,
  hlsIsSupportedMock,
  hlsLoadSourceMock,
  hlsAttachMediaMock,
  hlsOnMock,
  hlsOffMock,
  hlsDestroyMock,
  hlsStartLoadMock,
  hlsRecoverMediaErrorMock,
  hlsEventHandlers,
} = vi.hoisted(() => ({
  fetchPhotoCaptionMock: vi.fn(() => Promise.resolve(null as string | null)),
  hlsIsSupportedMock: vi.fn(() => false),
  hlsLoadSourceMock: vi.fn(),
  hlsAttachMediaMock: vi.fn(),
  hlsOnMock: vi.fn(),
  hlsOffMock: vi.fn(),
  hlsDestroyMock: vi.fn(),
  hlsStartLoadMock: vi.fn(),
  hlsRecoverMediaErrorMock: vi.fn(),
  hlsEventHandlers: new Map<string, (...args: unknown[]) => void>(),
}));

const useSelectionContextMock = vi.fn();

vi.mock("./selection/SelectionContext", () => ({
  useSelectionContext: () => useSelectionContextMock(),
}));

vi.mock("../videoPlaybackProfile", () => ({
  probeVideoPlaybackProfile: () => probeVideoPlaybackProfileMock(),
}));

vi.mock("../api", () => ({
  negotiateVideoPlayback: (...args: unknown[]) =>
    (negotiateVideoPlaybackMock as (...a: unknown[]) => unknown)(...args),
  fetchTranscriptSegments: () => Promise.resolve([]),
  fetchPeopleFacesForFile: () => Promise.resolve([]),
  fetchPhotoCaption: (...args: unknown[]) =>
    (fetchPhotoCaptionMock as (...a: unknown[]) => unknown)(...args),
}));

vi.mock("../diagnostics", () => ({
  logClientEvent: (...args: unknown[]) => logClientEventMock(...args),
  createClientOperationId: () => createClientOperationIdMock(),
}));

vi.mock("hls.js", () => ({
  default: class MockHls {
    static isSupported = hlsIsSupportedMock;
    static Events = {
      MANIFEST_PARSED: "manifestParsed",
      LEVEL_LOADED: "levelLoaded",
      BUFFER_APPENDED: "bufferAppended",
      LEVEL_SWITCHED: "levelSwitched",
      ERROR: "error",
    };
    static ErrorTypes = {
      NETWORK_ERROR: "networkError",
      MEDIA_ERROR: "mediaError",
    };
    static DefaultConfig = {
      loader: class MockLoader {
        load() {}
      },
    };

    media = null;
    levels = [{ height: 720 }];
    currentLevel = -1;
    loadSource = hlsLoadSourceMock;
    attachMedia = hlsAttachMediaMock;
    on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      hlsOnMock(event, handler);
      hlsEventHandlers.set(event, handler);
    });
    off = hlsOffMock;
    destroy = hlsDestroyMock;
    startLoad = hlsStartLoadMock;
    recoverMediaError = hlsRecoverMediaErrorMock;
  },
}));

vi.mock("./MiniMap", () => ({
  MiniMap: () => <div data-testid="mini-map">mini-map</div>,
}));

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

describe("FullscreenViewer", () => {
  beforeAll(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function showModal(
      this: HTMLDialogElement,
    ) {
      this.setAttribute("open", "");
    });
    HTMLDialogElement.prototype.close = vi.fn(function close(this: HTMLDialogElement) {
      this.removeAttribute("open");
    });
  });

  beforeEach(() => {
    useSelectionContextMock.mockReset();
    vi.restoreAllMocks();
    fetchPhotoCaptionMock.mockReset();
    fetchPhotoCaptionMock.mockResolvedValue(null);
    probeVideoPlaybackProfileMock.mockReset();
    probeVideoPlaybackProfileMock.mockResolvedValue({
      bandwidthMbps: 20,
      hevcSupported: true,
    });
    negotiateVideoPlaybackMock.mockReset();
    logClientEventMock.mockReset();
    createClientOperationIdMock.mockReset();
    createClientOperationIdMock.mockReturnValue("client-op-1");
    negotiateVideoPlaybackMock.mockResolvedValue({
      mode: "error",
      reason: "Connection too slow for the original and no GPU to transcode",
    });
    hlsIsSupportedMock.mockReset();
    hlsIsSupportedMock.mockReturnValue(false);
    hlsLoadSourceMock.mockReset();
    hlsAttachMediaMock.mockReset();
    hlsOnMock.mockReset();
    hlsOffMock.mockReset();
    hlsDestroyMock.mockReset();
    hlsStartLoadMock.mockReset();
    hlsRecoverMediaErrorMock.mockReset();
    hlsEventHandlers.clear();
  });

  it("renders selected image and closes via close button", () => {
    const setSelected = vi.fn();
    useSelectionContextMock.mockReturnValue({
      selected: createPhoto(),
      selectionMode: false,
      setSelected,
      selectNext: vi.fn(),
      selectPrevious: vi.fn(),
    });

    render(<FullscreenViewer />);

    expect(screen.getByRole("img", { name: "1.jpg" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(setSelected).toHaveBeenCalledWith(null);
  });

  it("fades the thumbnail placeholder out after the full image loads", () => {
    useSelectionContextMock.mockReturnValue({
      selected: createPhoto(),
      selectionMode: false,
      setSelected: vi.fn(),
      selectNext: vi.fn(),
      selectPrevious: vi.fn(),
    });

    const { container } = render(<FullscreenViewer />);

    const placeholder = container.querySelector(`.${swipeCss.thumb}`);
    const image = screen.getByRole("img", { name: "1.jpg" });

    expect(placeholder).not.toBeNull();
    expect(placeholder).toHaveStyle({ opacity: "1" });
    expect(image).toHaveStyle({ opacity: "0" });

    fireEvent.load(image);

    expect(placeholder).toHaveStyle({ opacity: "0" });
    expect(image).toHaveStyle({ opacity: "1" });
  });

  it("opens share and download quality options from preview actions", () => {
    useSelectionContextMock.mockReturnValue({
      selected: createPhoto(),
      selectionMode: false,
      setSelected: vi.fn(),
      selectNext: vi.fn(),
      selectPrevious: vi.fn(),
    });

    render(<FullscreenViewer />);

    fireEvent.click(screen.getByRole("button", { name: "Share item" }));

    const previewDialog = document.querySelector("dialog[open]");

    expect(screen.getByRole("heading", { name: "Share 1 item" })).toBeInTheDocument();
    expect(screen.getByText("Original")).toBeInTheDocument();
    expect(screen.getByText("Web-safe, original size")).toBeInTheDocument();
    expect(screen.getByText("Smaller size")).toBeInTheDocument();
    expect(previewDialog?.querySelector('[role="dialog"][aria-label="Share 1 item"]')).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(
      screen.queryByRole("heading", { name: "Share 1 item" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Download item" }));

    expect(screen.getByRole("heading", { name: "Download 1 item" })).toBeInTheDocument();
  });

  it("prints from the preview actions", () => {
    useSelectionContextMock.mockReturnValue({
      selected: createPhoto(),
      selectionMode: false,
      setSelected: vi.fn(),
      selectNext: vi.fn(),
      selectPrevious: vi.fn(),
    });

    const originalPrint = window.print;
    const printMock = vi.fn();
    Object.defineProperty(window, "print", {
      configurable: true,
      writable: true,
      value: printMock,
    });

    try {
      render(<FullscreenViewer />);

      fireEvent.click(screen.getByRole("button", { name: "Print item" }));

      expect(printMock).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, "print", {
        configurable: true,
        writable: true,
        value: originalPrint,
      });
    }
  });

  it("hides the print action for videos", () => {
    useSelectionContextMock.mockReturnValue({
      selected: createPhoto({
        path: "a/clip.mp4",
        name: "clip.mp4",
        mediaType: "video",
      }),
      selectionMode: false,
      setSelected: vi.fn(),
      selectNext: vi.fn(),
      selectPrevious: vi.fn(),
    });

    render(<FullscreenViewer />);

    expect(screen.queryByRole("button", { name: "Print item" })).not.toBeInTheDocument();
  });

  it("renders the AI caption toast inside the photo frame instead of the full viewer container", async () => {
    fetchPhotoCaptionMock.mockResolvedValue("Sunset at the beach");
    useSelectionContextMock.mockReturnValue({
      selected: createPhoto(),
      selectionMode: false,
      setSelected: vi.fn(),
      selectNext: vi.fn(),
      selectPrevious: vi.fn(),
    });

    const { container } = render(<FullscreenViewer />);

    const toast = await screen.findByRole("status");
    const swipeBox = container.querySelector(`.${swipeCss.box}`);

    expect(swipeBox).not.toBeNull();
    expect(toast.parentElement).toBe(swipeBox);
    expect(toast.closest(`.${css.container}`)).not.toBe(toast.parentElement);
  });

  it("shows file info and keeps the info panel open across close/open", () => {
    const setSelected = vi.fn();
    const selectedRef: { current: PhotoItem | null } = {
      current: createPhoto({
        path: "folder-a/1.jpg",
        name: "1.jpg",
        metadata: {
          mimeType: "image/jpeg",
          dimensionWidth: 4032,
          dimensionHeight: 3024,
        },
      }),
    };

    useSelectionContextMock.mockImplementation(() => ({
      selected: selectedRef.current,
      selectionMode: false,
      setSelected,
      selectNext: vi.fn(),
      selectPrevious: vi.fn(),
    }));

    const { rerender } = render(<FullscreenViewer />);

    fireEvent.click(screen.getByRole("button", { name: "Show file info" }));

    expect(screen.getByText("Path")).toBeInTheDocument();
    expect(screen.getByText("folder-a/1.jpg")).toBeInTheDocument();
    expect(screen.getByText("Filename")).toBeInTheDocument();
    expect(screen.getByText("1.jpg")).toBeInTheDocument();
    expect(screen.getByText("Type")).toBeInTheDocument();
    expect(screen.getByText("image/jpeg")).toBeInTheDocument();

    selectedRef.current = null;
    rerender(<FullscreenViewer />);

    selectedRef.current = createPhoto({
      path: "folder-b/2.jpg",
      name: "2.jpg",
      metadata: {
        cameraModel: "A7R V",
      },
    });
    rerender(<FullscreenViewer />);

    expect(screen.getByRole("button", { name: "Hide file info" })).toBeInTheDocument();
    expect(screen.getByText("folder-b/2.jpg")).toBeInTheDocument();
    expect(screen.getByText("2.jpg")).toBeInTheDocument();
    expect(screen.getAllByText("Camera").length).toBeGreaterThan(0);
    expect(screen.getByText("A7R V")).toBeInTheDocument();
  });

  // Regression test for feedback #63 ("can't click and drag the [crop]
  // handles"): the editor <aside> docks flush against the media container's
  // right edge, and the crop box's handles are centered *on* the photo's
  // edge — so on a photo wide enough to fill the shrunk container, the
  // right-side handles were half-clipped by the container's overflow and
  // half-covered by the editor panel, leaving no clickable pixels. The fix
  // reserves a clearance strip on that edge while editing.
  it("reserves clearance from the editor panel so crop handles aren't clipped/covered", () => {
    useSelectionContextMock.mockReturnValue({
      selected: createPhoto(),
      selectionMode: false,
      setSelected: vi.fn(),
      selectNext: vi.fn(),
      selectPrevious: vi.fn(),
    });

    const { container } = render(<FullscreenViewer />);

    const mediaContainer = container.querySelector(`.${css.container}`);
    expect(mediaContainer?.className).not.toContain(css.containerEditing);

    fireEvent.click(screen.getByRole("button", { name: "Edit photo" }));

    expect(screen.getByRole("complementary", { name: "Photo editor" })).toBeInTheDocument();
    const editingContainer = container.querySelector(`.${css.container}`);
    expect(editingContainer?.className).toContain(css.containerEditing);
  });

  it("toggles face overlays for photo regions", () => {
    useSelectionContextMock.mockReturnValue({
      selected: createPhoto({
        metadata: {
          regions: [
            {
              name: "Person A",
              area: {
                x: 0.5,
                y: 0.6,
                width: 0.4,
                height: 0.4,
              },
            },
            {
              name: "Person B",
              area: {
                x: 0.7,
                y: 0.3,
                width: 0.2,
                height: 0.2,
              },
            },
          ],
        },
      }),
      selectionMode: false,
      setSelected: vi.fn(),
      selectNext: vi.fn(),
      selectPrevious: vi.fn(),
    });

    const { container } = render(<FullscreenViewer />);

    expect(container.querySelectorAll(`.${css.faceBackdropLayer}`)).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Show faces" }));

    const layers = container.querySelectorAll(`.${css.faceBackdropLayer}`);
    expect(layers).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Hide faces" })).toBeInTheDocument();
    expect((layers[0] as HTMLElement).style.maskImage).toContain("data:image/svg+xml");
  });

  it("renders face rectangles from stringified regions metadata", () => {
    useSelectionContextMock.mockReturnValue({
      selected: createPhoto({
        metadata: {
          regions:
            '[{"name":"Scott Douglas Richards","type":"Face","area":{"x":0.48237,"y":0.15012,"width":0.08638,"height":0.15357},"rotation":-0.08126},{"type":"Face","area":{"x":0.25385,"y":0.37243,"width":0.09242,"height":0.1643},"rotation":-0.0916},{"type":"Face","area":{"x":0.76768,"y":0.58686,"width":0.14158,"height":0.25171},"rotation":0.23}]',
        },
      }),
      selectionMode: false,
      setSelected: vi.fn(),
      selectNext: vi.fn(),
      selectPrevious: vi.fn(),
    });

    const { container } = render(<FullscreenViewer />);
    fireEvent.click(screen.getByRole("button", { name: "Show faces" }));

    expect(container.querySelectorAll(`.${css.faceFrameRect}`)).toHaveLength(3);
  });

  it("enables and renders face overlay from face table boxes", () => {
    useSelectionContextMock.mockReturnValue({
      selected: createPhoto({
        metadata: {
          faceTableBoxes: [{ x: 0.2, y: 0.3, width: 0.15, height: 0.2 }],
        },
      }),
      selectionMode: false,
      setSelected: vi.fn(),
      selectNext: vi.fn(),
      selectPrevious: vi.fn(),
    });

    const { container } = render(<FullscreenViewer />);
    const faceToggle = screen.getByRole("button", { name: "Show faces" });

    expect(faceToggle).toBeEnabled();
    fireEvent.click(faceToggle);

    expect(container.querySelectorAll(`.${css.faceTableFrameRect}`)).toHaveLength(1);
    expect(container.querySelectorAll(`.${css.exifFaceFrameRect}`)).toHaveLength(0);
  });

  it("renders exif and face-table overlays with different classes", () => {
    useSelectionContextMock.mockReturnValue({
      selected: createPhoto({
        metadata: {
          regions: [
            {
              type: "Face",
              area: {
                x: 0.4,
                y: 0.4,
                width: 0.2,
                height: 0.2,
              },
            },
          ],
          faceTableBoxes: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }],
        },
      }),
      selectionMode: false,
      setSelected: vi.fn(),
      selectNext: vi.fn(),
      selectPrevious: vi.fn(),
    });

    const { container } = render(<FullscreenViewer />);
    fireEvent.click(screen.getByRole("button", { name: "Show faces" }));

    expect(container.querySelectorAll(`.${css.exifFaceFrameRect}`)).toHaveLength(1);
    expect(container.querySelectorAll(`.${css.faceTableFrameRect}`)).toHaveLength(1);
  });

  it("disables face toggle for video media items", () => {
    useSelectionContextMock.mockReturnValue({
      selected: createPhoto({
        mediaType: "video",
      }),
      selectionMode: false,
      setSelected: vi.fn(),
      selectNext: vi.fn(),
      selectPrevious: vi.fn(),
    });

    render(<FullscreenViewer />);

    expect(screen.getByRole("button", { name: "Show faces" })).toBeDisabled();
  });

  it("toggles zoom on tap and centres the transform", () => {
    useSelectionContextMock.mockReturnValue({
      selected: createPhoto(),
      selectionMode: false,
      setSelected: vi.fn(),
      selectNext: vi.fn(),
      selectPrevious: vi.fn(),
    });

    const { container } = render(<FullscreenViewer />);

    const image = screen.getByRole("img", { name: "1.jpg" });
    const box = container.querySelector(`.${swipeCss.box}`) as HTMLElement;
    expect(box).not.toBeNull();

    // A mouse tap (pointer down + up without movement) zooms in.
    fireEvent.pointerDown(image, { pointerId: 1, pointerType: "mouse", button: 0 });
    fireEvent.pointerUp(image, { pointerId: 1, pointerType: "mouse" });
    expect(box.style.transform).toContain("scale(2.5)");

    // Tapping again zooms back out.
    fireEvent.pointerDown(image, { pointerId: 1, pointerType: "mouse", button: 0 });
    fireEvent.pointerUp(image, { pointerId: 1, pointerType: "mouse" });
    expect(box.style.transform).toContain("scale(1)");
  });

  it("supports scroll zoom while already zoomed", () => {
    useSelectionContextMock.mockReturnValue({
      selected: createPhoto(),
      selectionMode: false,
      setSelected: vi.fn(),
      selectNext: vi.fn(),
      selectPrevious: vi.fn(),
    });

    const { container } = render(<FullscreenViewer />);

    const image = screen.getByRole("img", { name: "1.jpg" });
    const box = container.querySelector(`.${swipeCss.box}`) as HTMLElement;

    fireEvent.pointerDown(image, { pointerId: 1, pointerType: "mouse", button: 0 });
    fireEvent.pointerUp(image, { pointerId: 1, pointerType: "mouse" });
    expect(box.style.transform).toContain("scale(2.5)");

    fireEvent.wheel(image, { deltaY: -1 });
    expect(box.style.transform).toContain("scale(2.75)");

    fireEvent.wheel(image, { deltaY: 1 });
    expect(box.style.transform).toContain("scale(2.5)");
  });

  it("handles keyboard navigation and escape", () => {
    const selectNext = vi.fn();
    const selectPrevious = vi.fn();
    const setSelected = vi.fn();

    useSelectionContextMock.mockReturnValue({
      selected: createPhoto(),
      selectionMode: false,
      setSelected,
      selectNext,
      selectPrevious,
    });

    render(<FullscreenViewer />);

    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    fireEvent.keyDown(window, { key: "Escape" });

    expect(selectNext).toHaveBeenCalledTimes(1);
    expect(selectPrevious).toHaveBeenCalledTimes(1);
    expect(setSelected).toHaveBeenCalledWith(null);
  });

  it("handles swipe gestures for next and previous", () => {
    const selectNext = vi.fn();
    const selectPrevious = vi.fn();

    // The carousel only navigates towards a neighbour, so provide a middle item.
    const items = [
      createPhoto({ path: "a/0.jpg", name: "0.jpg" }),
      createPhoto({ path: "a/1.jpg", name: "1.jpg" }),
      createPhoto({ path: "a/2.jpg", name: "2.jpg" }),
    ];

    useSelectionContextMock.mockReturnValue({
      items,
      selected: items[1],
      selectionMode: false,
      setSelected: vi.fn(),
      selectNext,
      selectPrevious,
    });

    const { container } = render(<FullscreenViewer />);
    const viewport = container.querySelector(`.${swipeCss.viewport}`) as HTMLElement;
    const track = container.querySelector(`.${swipeCss.track}`) as HTMLElement;
    expect(viewport).not.toBeNull();
    expect(track).not.toBeNull();

    // Swipe left → next. Navigation commits once the slide transition ends.
    fireEvent.pointerDown(viewport, { pointerId: 1, pointerType: "touch", clientX: 200, clientY: 100 });
    fireEvent.pointerMove(viewport, { pointerId: 1, pointerType: "touch", clientX: 100, clientY: 100 });
    fireEvent.pointerUp(viewport, { pointerId: 1, pointerType: "touch", clientX: 100, clientY: 100 });
    fireEvent.transitionEnd(track, { propertyName: "transform" });

    // Swipe right → previous.
    fireEvent.pointerDown(viewport, { pointerId: 2, pointerType: "touch", clientX: 100, clientY: 100 });
    fireEvent.pointerMove(viewport, { pointerId: 2, pointerType: "touch", clientX: 200, clientY: 100 });
    fireEvent.pointerUp(viewport, { pointerId: 2, pointerType: "touch", clientX: 200, clientY: 100 });
    fireEvent.transitionEnd(track, { propertyName: "transform" });

    expect(selectNext).toHaveBeenCalledTimes(1);
    expect(selectPrevious).toHaveBeenCalledTimes(1);
  });

  it("locks body scroll when open and restores on close", () => {
    const setSelected = vi.fn();
    useSelectionContextMock.mockReturnValue({
      selected: createPhoto(),
      selectionMode: false,
      setSelected,
      selectNext: vi.fn(),
      selectPrevious: vi.fn(),
    });

    const { unmount } = render(<FullscreenViewer />);

    expect(document.documentElement.style.overflow).toBe("hidden");
    expect(document.documentElement.style.scrollbarGutter).toBe("unset");

    unmount();
    expect(document.documentElement.style.overflow).toBe("");
    expect(document.documentElement.style.scrollbarGutter).toBe("");
  });

  it("renders media when a selected photo exists", () => {
    useSelectionContextMock.mockReturnValue({
      selected: createPhoto(),
      selectionMode: true,
      setSelected: vi.fn(),
      selectNext: vi.fn(),
      selectPrevious: vi.fn(),
    });

    render(<FullscreenViewer />);

    expect(screen.getByRole("img", { name: "1.jpg" })).toBeInTheDocument();
  });

  it("closes when backdrop or empty container area is clicked", () => {
    const setSelected = vi.fn();
    useSelectionContextMock.mockReturnValue({
      selected: createPhoto(),
      selectionMode: false,
      setSelected,
      selectNext: vi.fn(),
      selectPrevious: vi.fn(),
    });

    const { container } = render(<FullscreenViewer />);
    const dialog = container.querySelector("dialog");
    const innerContainer = container.querySelector("dialog div");

    expect(dialog).not.toBeNull();
    expect(innerContainer).not.toBeNull();

    fireEvent.click(dialog!);
    fireEvent.click(innerContainer!);

    expect(setSelected).toHaveBeenCalledWith(null);
  });

  it("renders video element for selected video media", () => {
    useSelectionContextMock.mockReturnValue({
      selected: createPhoto({
        path: "a/clip.mp4",
        name: "clip.mp4",
        mediaType: "video",
      }),
      selectionMode: false,
      setSelected: vi.fn(),
      selectNext: vi.fn(),
      selectPrevious: vi.fn(),
    });

    const { container } = render(<FullscreenViewer />);
    const video = container.querySelector("video");

    expect(video).not.toBeNull();
  });

  it("logs media element waiting and stalled events for videos", async () => {
    useSelectionContextMock.mockReturnValue({
      selected: createPhoto({
        path: "a/clip.mp4",
        name: "clip.mp4",
        mediaType: "video",
      }),
      selectionMode: false,
      setSelected: vi.fn(),
      selectNext: vi.fn(),
      selectPrevious: vi.fn(),
    });

    const { container } = render(<FullscreenViewer />);
    const video = container.querySelector("video");

    expect(video).not.toBeNull();
    fireEvent(video!, new Event("waiting"));
    fireEvent(video!, new Event("stalled"));

    await waitFor(() => {
      expect(logClientEventMock).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "video.element.waiting",
          clientOperationId: "client-op-1",
        }),
      );
      expect(logClientEventMock).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "video.element.stalled",
          clientOperationId: "client-op-1",
        }),
      );
    });
  });

  it("plays the raw original when server negotiates direct mode", async () => {
    negotiateVideoPlaybackMock.mockResolvedValue({
      mode: "direct",
      url: "http://localhost/a/fast.mp4",
      reason: "Direct playback — connection can carry the original",
    });

    useSelectionContextMock.mockReturnValue({
      selected: createPhoto({
        path: "a/fast.mp4",
        name: "fast.mp4",
        mediaType: "video",
        originalUrl: "http://localhost/a/fast.mp4?token=abc",
        metadata: {
          sizeInBytes: 2_000_000,
          duration: 2,
          videoCodec: "h264",
        },
      }),
      selectionMode: false,
      setSelected: vi.fn(),
      selectNext: vi.fn(),
      selectPrevious: vi.fn(),
    });

    const { container } = render(<FullscreenViewer />);
    const video = container.querySelector("video");

    expect(video).not.toBeNull();
    await waitFor(() => {
      // Plays the token-bearing client URL directly; no HLS involved.
      expect(video?.getAttribute("src")).toBe("http://localhost/a/fast.mp4?token=abc");
      expect(hlsLoadSourceMock).not.toHaveBeenCalled();
      expect(screen.getByTestId("video-status")).toHaveTextContent("Raw Video");
    });
  });

  it("uses HLS when server negotiates HLS mode and HLS.js is available", async () => {
    hlsIsSupportedMock.mockReturnValue(true);
    negotiateVideoPlaybackMock.mockResolvedValue({
      mode: "hls",
      url: "http://localhost/a/standard.m3u8",
      reason: "Cached HLS available",
    });

    useSelectionContextMock.mockReturnValue({
      selected: createPhoto({
        path: "a/standard.mp4",
        name: "standard.mp4",
        mediaType: "video",
        originalUrl: "http://localhost/a/standard.mp4",
        hlsUrl: "http://localhost/a/standard.m3u8",
        metadata: {
          sizeInBytes: 2_000_000,
          duration: 2,
          videoCodec: "hevc",
        },
      }),
      selectionMode: false,
      setSelected: vi.fn(),
      selectNext: vi.fn(),
      selectPrevious: vi.fn(),
    });

    const { container } = render(<FullscreenViewer />);
    const video = container.querySelector("video");

    expect(video).not.toBeNull();
    await waitFor(() => {
      expect(hlsLoadSourceMock).toHaveBeenCalledWith("http://localhost/a/standard.m3u8");
      expect(hlsAttachMediaMock).toHaveBeenCalledWith(video);
      expect(video?.getAttribute("src")).toBeNull();
      expect(screen.getByTestId("video-status")).toHaveTextContent("HLS");
    });
  });

  it("marks playback unavailable — never raw — after repeated HLS network failures", async () => {
    hlsIsSupportedMock.mockReturnValue(true);
    negotiateVideoPlaybackMock.mockResolvedValue({
      mode: "hls",
      url: "http://localhost/a/standard.m3u8",
      reason: "Cached HLS available",
    });

    useSelectionContextMock.mockReturnValue({
      selected: createPhoto({
        path: "a/standard.mp4",
        name: "standard.mp4",
        mediaType: "video",
        fullUrl: "http://localhost/a/standard.mp4",
        originalUrl: "http://localhost/a/standard.mp4",
        metadata: {
          sizeInBytes: 2_000_000,
          duration: 2,
          videoCodec: "h264",
        },
      }),
      selectionMode: false,
      setSelected: vi.fn(),
      selectNext: vi.fn(),
      selectPrevious: vi.fn(),
    });

    const { container } = render(<FullscreenViewer />);
    const video = container.querySelector("video");

    expect(video).not.toBeNull();
    await waitFor(() => {
      expect(hlsLoadSourceMock).toHaveBeenCalledWith("http://localhost/a/standard.m3u8");
    });

    const errorHandler = hlsEventHandlers.get("error");
    expect(errorHandler).toBeDefined();

    errorHandler?.("error", {
      fatal: true,
      type: "networkError",
      details: "manifestLoadError",
    });
    errorHandler?.("error", {
      fatal: true,
      type: "networkError",
      details: "manifestLoadError",
    });
    errorHandler?.("error", {
      fatal: true,
      type: "networkError",
      details: "manifestLoadError",
    });

    expect(hlsStartLoadMock).toHaveBeenCalledTimes(2);
    await waitFor(() => {
      // No raw fallback: an unrecoverable HLS error fails visibly.
      expect(video?.getAttribute("src")).toBeNull();
      expect(screen.getByTestId("video-status")).toHaveTextContent(
        "Playback Unavailable",
      );
    });
  });

  it("marks playback unavailable — never raw — when server negotiates error mode", async () => {
    negotiateVideoPlaybackMock.mockResolvedValue({
      mode: "error",
      reason: "Connection too slow for the original and no GPU to transcode",
    });

    useSelectionContextMock.mockReturnValue({
      selected: createPhoto({
        path: "a/weird.mkv",
        name: "weird.mkv",
        mediaType: "video",
        originalUrl: "http://localhost/a/weird.mkv",
        fullUrl: "http://localhost/a/weird-websafe.mp4",
        metadata: {
          sizeInBytes: 2_000_000,
          duration: 2,
          videoCodec: "vp9",
        },
      }),
      selectionMode: false,
      setSelected: vi.fn(),
      selectNext: vi.fn(),
      selectPrevious: vi.fn(),
    });

    const { container } = render(<FullscreenViewer />);
    const video = container.querySelector("video");

    expect(video).not.toBeNull();
    await waitFor(() => {
      // The raw original is never loaded, even for a codec the browser might play.
      expect(video?.getAttribute("src")).toBeNull();
      expect(screen.getByTestId("video-status")).toHaveTextContent(
        "Playback Unavailable",
      );
    });
  });

  describe("live photo", () => {
    it("shows live photo button for photos with livePhotoUrl", () => {
      useSelectionContextMock.mockReturnValue({
        selected: createPhoto({ livePhotoUrl: "http://localhost/a/1.MOV" }),
        selectionMode: false,
        setSelected: vi.fn(),
        selectNext: vi.fn(),
        selectPrevious: vi.fn(),
      });

      render(<FullscreenViewer />);

      expect(screen.getByRole("button", { name: "Play live photo" })).toBeInTheDocument();
    });

    it("does not show live photo button for photos without livePhotoUrl", () => {
      useSelectionContextMock.mockReturnValue({
        selected: createPhoto(),
        selectionMode: false,
        setSelected: vi.fn(),
        selectNext: vi.fn(),
        selectPrevious: vi.fn(),
      });

      render(<FullscreenViewer />);

      expect(
        screen.queryByRole("button", { name: "Play live photo" }),
      ).not.toBeInTheDocument();
    });

    it("does not show live photo button for video media items", () => {
      useSelectionContextMock.mockReturnValue({
        selected: createPhoto({
          mediaType: "video",
          livePhotoUrl: "http://localhost/a/1.MOV",
        }),
        selectionMode: false,
        setSelected: vi.fn(),
        selectNext: vi.fn(),
        selectPrevious: vi.fn(),
      });

      const { container } = render(<FullscreenViewer />);

      expect(
        screen.queryByRole("button", { name: "Play live photo" }),
      ).not.toBeInTheDocument();
      expect(container.querySelector("video")).not.toBeNull();
    });

    it("clicking live photo button shows the live video and hides the still image", () => {
      useSelectionContextMock.mockReturnValue({
        selected: createPhoto({ livePhotoUrl: "http://localhost/a/1.MOV" }),
        selectionMode: false,
        setSelected: vi.fn(),
        selectNext: vi.fn(),
        selectPrevious: vi.fn(),
      });

      const { container } = render(<FullscreenViewer />);

      expect(screen.getByRole("img", { name: "1.jpg" })).toBeInTheDocument();
      expect(container.querySelector("video")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Play live photo" }));

      expect(screen.queryByRole("img", { name: "1.jpg" })).not.toBeInTheDocument();
      expect(
        container.querySelector("video[src='http://localhost/a/1.MOV']"),
      ).not.toBeNull();
      expect(screen.getByRole("button", { name: "Show photo" })).toBeInTheDocument();
    });

    it("clicking live photo button again switches back to the still image", () => {
      useSelectionContextMock.mockReturnValue({
        selected: createPhoto({ livePhotoUrl: "http://localhost/a/1.MOV" }),
        selectionMode: false,
        setSelected: vi.fn(),
        selectNext: vi.fn(),
        selectPrevious: vi.fn(),
      });

      const { container } = render(<FullscreenViewer />);

      fireEvent.click(screen.getByRole("button", { name: "Play live photo" }));
      fireEvent.click(screen.getByRole("button", { name: "Show photo" }));

      expect(screen.getByRole("img", { name: "1.jpg" })).toBeInTheDocument();
      expect(container.querySelector("video[src='http://localhost/a/1.MOV']")).toBeNull();
    });
  });
});
