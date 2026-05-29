import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import type { PhotoItem } from "../api";
import { FullscreenViewer } from "./FullscreenViewer";
import css from "./FullscreenViewer.module.css";

const probeVideoPlaybackProfileMock = vi.fn().mockResolvedValue({
  bandwidthMbps: 20,
  hevcSupported: true,
});

const negotiateVideoPlaybackMock = vi.fn();

const {
  hlsIsSupportedMock,
  hlsLoadSourceMock,
  hlsAttachMediaMock,
  hlsOnMock,
  hlsDestroyMock,
} = vi.hoisted(() => ({
  hlsIsSupportedMock: vi.fn(() => false),
  hlsLoadSourceMock: vi.fn(),
  hlsAttachMediaMock: vi.fn(),
  hlsOnMock: vi.fn(),
  hlsDestroyMock: vi.fn(),
}));

const useSelectionContextMock = vi.fn();

vi.mock("./selection/SelectionContext", () => ({
  useSelectionContext: () => useSelectionContextMock(),
}));

vi.mock("../videoPlaybackProfile", () => ({
  probeVideoPlaybackProfile: () => probeVideoPlaybackProfileMock(),
}));

vi.mock("../api", () => ({
  negotiateVideoPlayback: (...args: unknown[]) => negotiateVideoPlaybackMock(...args),
}));

vi.mock("hls.js", () => ({
  default: class MockHls {
    static isSupported = hlsIsSupportedMock;
    static Events = {
      MANIFEST_PARSED: "manifestParsed",
      ERROR: "error",
    };
    static DefaultConfig = {
      loader: class MockLoader {
        load() {}
      },
    };

    media = null;
    loadSource = hlsLoadSourceMock;
    attachMedia = hlsAttachMediaMock;
    on = hlsOnMock;
    destroy = hlsDestroyMock;
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
    HTMLDialogElement.prototype.showModal = vi.fn(function showModal(this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });
    HTMLDialogElement.prototype.close = vi.fn(function close(this: HTMLDialogElement) {
      this.removeAttribute("open");
    });
  });

  beforeEach(() => {
    useSelectionContextMock.mockReset();
    vi.restoreAllMocks();
    probeVideoPlaybackProfileMock.mockReset();
    probeVideoPlaybackProfileMock.mockResolvedValue({
      bandwidthMbps: 20,
      hevcSupported: true,
    });
    negotiateVideoPlaybackMock.mockReset();
    negotiateVideoPlaybackMock.mockResolvedValue({
      mode: "direct",
      url: "/api/files/video.mp4",
      reason: "Direct playback",
    });
    hlsIsSupportedMock.mockReset();
    hlsIsSupportedMock.mockReturnValue(false);
    hlsLoadSourceMock.mockReset();
    hlsAttachMediaMock.mockReset();
    hlsOnMock.mockReset();
    hlsDestroyMock.mockReset();
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
    expect(screen.getByText("mimeType")).toBeInTheDocument();
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
    expect(screen.getByText("cameraModel")).toBeInTheDocument();
    expect(screen.getByText("A7R V")).toBeInTheDocument();
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
    expect(
      (layers[0] as HTMLElement).style.maskImage,
    ).toContain("data:image/svg+xml");
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

  it("zooms the photo around clicked coordinates", () => {
    useSelectionContextMock.mockReturnValue({
      selected: createPhoto(),
      selectionMode: false,
      setSelected: vi.fn(),
      selectNext: vi.fn(),
      selectPrevious: vi.fn(),
    });

    render(<FullscreenViewer />);

    const image = screen.getByRole("img", { name: "1.jpg" });
    vi.spyOn(image, "getBoundingClientRect").mockReturnValue({
      x: 10,
      y: 20,
      left: 10,
      top: 20,
      right: 210,
      bottom: 220,
      width: 200,
      height: 200,
      toJSON: () => ({}),
    } as DOMRect);

    fireEvent.click(image, { clientX: 60, clientY: 80 });

    expect(image).toHaveClass(css.zoomedMedia);
    expect(image.style.getPropertyValue("--zoom-origin-x")).toBe("25%");
    expect(image.style.getPropertyValue("--zoom-origin-y")).toBe("30%");

    fireEvent.click(image, { clientX: 80, clientY: 90 });

    expect(image).not.toHaveClass(css.zoomedMedia);
    expect(image.style.getPropertyValue("--zoom-origin-x")).toBe("25%");
    expect(image.style.getPropertyValue("--zoom-origin-y")).toBe("30%");
  });

  it("supports scroll zoom while already zoomed", () => {
    useSelectionContextMock.mockReturnValue({
      selected: createPhoto(),
      selectionMode: false,
      setSelected: vi.fn(),
      selectNext: vi.fn(),
      selectPrevious: vi.fn(),
    });

    render(<FullscreenViewer />);

    const image = screen.getByRole("img", { name: "1.jpg" });
    vi.spyOn(image, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 200,
      bottom: 200,
      width: 200,
      height: 200,
      toJSON: () => ({}),
    } as DOMRect);

    fireEvent.click(image, { clientX: 100, clientY: 100 });
    expect(image).toHaveClass(css.zoomedMedia);
    expect(image.style.getPropertyValue("--zoom-scale")).toBe("2.5");

    fireEvent.wheel(image, { deltaY: -1 });
    expect(image).toHaveClass(css.zoomedMedia);
    expect(image.style.getPropertyValue("--zoom-scale")).toBe("2.75");

    fireEvent.wheel(image, { deltaY: 1 });
    expect(image.style.getPropertyValue("--zoom-scale")).toBe("2.5");
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

    useSelectionContextMock.mockReturnValue({
      selected: createPhoto(),
      selectionMode: false,
      setSelected: vi.fn(),
      selectNext,
      selectPrevious,
    });

    const { container } = render(<FullscreenViewer />);
    const swipeContainer = container.querySelector(`.${css.container}`);
    expect(swipeContainer).not.toBeNull();

    fireEvent.touchStart(swipeContainer!, {
      changedTouches: [{ clientX: 200, clientY: 100 }],
    });
    fireEvent.touchEnd(swipeContainer!, {
      changedTouches: [{ clientX: 100, clientY: 100 }],
    });

    fireEvent.touchStart(swipeContainer!, {
      changedTouches: [{ clientX: 100, clientY: 100 }],
    });
    fireEvent.touchEnd(swipeContainer!, {
      changedTouches: [{ clientX: 200, clientY: 100 }],
    });

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

  it("does not render media while selection mode is active", () => {
    useSelectionContextMock.mockReturnValue({
      selected: createPhoto(),
      selectionMode: true,
      setSelected: vi.fn(),
      selectNext: vi.fn(),
      selectPrevious: vi.fn(),
    });

    render(<FullscreenViewer />);

    expect(screen.queryByRole("img", { name: "1.jpg" })).not.toBeInTheDocument();
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

  it("uses direct video source when server negotiates direct mode", async () => {
    negotiateVideoPlaybackMock.mockResolvedValue({
      mode: "direct",
      url: "http://localhost/a/hevc.mov",
      reason: "Direct playback",
    });

    useSelectionContextMock.mockReturnValue({
      selected: createPhoto({
        path: "a/hevc.mov",
        name: "hevc.mov",
        mediaType: "video",
        originalUrl: "http://localhost/a/hevc.mov",
        hlsUrl: "http://localhost/a/hevc.m3u8",
        metadata: {
          sizeInBytes: 1_000_000,
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
      expect(negotiateVideoPlaybackMock).toHaveBeenCalledWith({
        path: "a/hevc.mov",
        bandwidthMbps: 20,
        hevcSupported: true,
      });
      expect(video?.getAttribute("src")).toBe("http://localhost/a/hevc.mov");
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

  it("falls back to fullUrl when server negotiates error mode", async () => {
    negotiateVideoPlaybackMock.mockResolvedValue({
      mode: "error",
      reason: "No compatible format",
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
      expect(video?.getAttribute("src")).toBe("http://localhost/a/weird-websafe.mp4");
      expect(screen.getByTestId("video-status")).toHaveTextContent("No Compatible Stream");
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

      expect(screen.queryByRole("button", { name: "Play live photo" })).not.toBeInTheDocument();
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

      expect(screen.queryByRole("button", { name: "Play live photo" })).not.toBeInTheDocument();
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
      expect(container.querySelector("video[src='http://localhost/a/1.MOV']")).not.toBeNull();
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
