import { fireEvent, render, screen } from "@testing-library/react";
import type { PhotoItem } from "../api";
import { FullscreenViewer } from "./FullscreenViewer";

const useSelectionContextMock = vi.fn();

vi.mock("./selection/SelectionContext", () => ({
  useSelectionContext: () => useSelectionContextMock(),
}));

vi.mock("hls.js", () => ({
  default: {
    isSupported: () => false,
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
});
