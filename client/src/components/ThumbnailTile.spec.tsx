import { fireEvent, render, screen } from "@testing-library/react";
import type { PhotoItem } from "../api";
import { ThumbnailTile } from "./ThumbnailTile";

const useSelectionContextMock = vi.fn();

vi.mock("./selection/SelectionContext", () => ({
  useSelectionContext: () => useSelectionContextMock(),
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

describe("ThumbnailTile", () => {
  beforeEach(() => {
    useSelectionContextMock.mockReset();
    useSelectionContextMock.mockReturnValue({
      isSelected: vi.fn().mockReturnValue(false),
      selectionMode: false,
      setSelected: vi.fn(),
      setSelectionMode: vi.fn(),
      toggleSelected: vi.fn(),
    });
  });

  it("opens photo when clicked in normal mode", () => {
    const setSelected = vi.fn();
    useSelectionContextMock.mockReturnValue({
      isSelected: vi.fn().mockReturnValue(false),
      selectionMode: false,
      setSelected,
      setSelectionMode: vi.fn(),
      toggleSelected: vi.fn(),
    });

    const photo = createPhoto();
    render(<ThumbnailTile photo={photo} />);

    fireEvent.click(screen.getByRole("button", { name: "1.jpg" }));

    expect(setSelected).toHaveBeenCalledWith(photo);
  });

  it("toggles selection when clicked in selection mode", () => {
    const toggleSelected = vi.fn();
    useSelectionContextMock.mockReturnValue({
      isSelected: vi.fn().mockReturnValue(false),
      selectionMode: true,
      setSelected: vi.fn(),
      setSelectionMode: vi.fn(),
      toggleSelected,
    });

    const photo = createPhoto();
    render(<ThumbnailTile photo={photo} />);

    fireEvent.click(screen.getByRole("button", { name: "1.jpg" }));

    expect(toggleSelected).toHaveBeenCalledWith(photo);
  });

  it("shows video preview element while hovered for video items", () => {
    const photo = createPhoto({
      path: "a/clip.mp4",
      name: "clip.mp4",
      mediaType: "video",
      videoPreviewUrl: "http://localhost/a/clip-preview.mp4",
    });

    const { container } = render(<ThumbnailTile photo={photo} />);
    const tile = screen.getByRole("button", { name: "clip.mp4" });

    fireEvent.mouseEnter(tile);

    const video = container.querySelector("video");
    expect(video).not.toBeNull();
    expect(video?.getAttribute("src")).toBe("http://localhost/a/clip-preview.mp4");
  });

  it("marks button pressed when item is selected", () => {
    useSelectionContextMock.mockReturnValue({
      isSelected: vi.fn().mockReturnValue(true),
      selectionMode: true,
      setSelected: vi.fn(),
      setSelectionMode: vi.fn(),
      toggleSelected: vi.fn(),
    });

    const photo = createPhoto();
    render(<ThumbnailTile photo={photo} />);

    expect(screen.getByRole("button", { name: "1.jpg" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("enters selection mode on long press and suppresses following click", () => {
    vi.useFakeTimers();
    const setSelectionMode = vi.fn();
    const setSelected = vi.fn();
    const toggleSelected = vi.fn();

    useSelectionContextMock.mockReturnValue({
      isSelected: vi.fn().mockReturnValue(false),
      selectionMode: false,
      setSelected,
      setSelectionMode,
      toggleSelected,
    });

    const photo = createPhoto();
    render(<ThumbnailTile photo={photo} />);
    const tile = screen.getByRole("button", { name: "1.jpg" });

    fireEvent.touchStart(tile);
    vi.advanceTimersByTime(500);
    fireEvent.click(tile);

    expect(setSelectionMode).toHaveBeenCalledWith(true);
    expect(setSelected).toHaveBeenCalledTimes(1);
    expect(setSelected).toHaveBeenCalledWith(photo);
    expect(toggleSelected).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("fades image in when it finishes loading", () => {
    const photo = createPhoto();
    render(<ThumbnailTile photo={photo} />);

    const image = screen.getByRole("img", { name: "1.jpg" });
    expect(image).toHaveStyle({ opacity: "0" });

    fireEvent.load(image);

    expect(image).toHaveStyle({ opacity: "1" });
  });
});
