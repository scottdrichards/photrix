import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PhotoItem } from "../api";
import { FullscreenViewer } from "./FullscreenViewer";

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
    const swipeContainer = container.querySelector("dialog div");
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
});
