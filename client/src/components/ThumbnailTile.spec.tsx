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
      items: [],
      selected: null,
      setSelected: vi.fn(),
      setItems: vi.fn(),
      selectNext: vi.fn(),
      selectPrevious: vi.fn(),
    });
  });

  it("opens photo when clicked in normal mode", () => {
    const setSelected = vi.fn();
    useSelectionContextMock.mockReturnValue({
      setSelected,
    });

    const photo = createPhoto();
    render(<ThumbnailTile photo={photo} />);

    fireEvent.click(screen.getByRole("button", { name: "1.jpg" }));

    expect(setSelected).toHaveBeenCalledWith(photo);
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
    expect(image).toHaveAttribute("src", "http://localhost/a/1.jpg");
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
