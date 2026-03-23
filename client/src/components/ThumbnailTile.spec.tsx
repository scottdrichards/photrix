import { act, fireEvent, render, screen } from "@testing-library/react";
import type { PhotoItem } from "../api";
import { ThumbnailTile } from "./ThumbnailTile";

const useSelectionContextMock = vi.fn();
const intersectionObservers: { trigger: (isIntersecting: boolean) => void }[] = [];
const originalIntersectionObserver = globalThis.IntersectionObserver;

vi.mock("./selection/SelectionContext", () => ({
  useSelectionContext: () => useSelectionContextMock(),
}));

beforeAll(() => {
  class FakeIntersectionObserver {
    private callback: IntersectionObserverCallback;

    constructor(callback: IntersectionObserverCallback) {
      this.callback = callback;
      intersectionObservers.push({
        trigger: (isIntersecting: boolean) => {
          this.callback(
            [{ isIntersecting } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          );
        },
      });
    }

    observe = vi.fn();
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
    intersectionObservers.forEach((observer) => observer.trigger(isIntersecting));
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
    intersectionObservers.length = 0;
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
    triggerIntersection(true);

    const image = screen.getByRole("img", { name: "1.jpg" });
    expect(image).toHaveStyle({ opacity: "0" });

    fireEvent.load(image);

    expect(image).toHaveStyle({ opacity: "1" });
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
    expect(image).toHaveAttribute("src", "http://localhost/a/1.jpg");
  });

});
