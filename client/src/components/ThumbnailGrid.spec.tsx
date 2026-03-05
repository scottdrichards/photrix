import { act, render, screen, waitFor } from "@testing-library/react";
import type { PhotoItem } from "../api";
import { FilterProvider } from "./filter/FilterContext";
import { SelectionProvider } from "./selection/SelectionContext";
import { ThumbnailGrid } from "./ThumbnailGrid";

const fetchPhotosMock = vi.fn();

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    fetchPhotos: (...args: unknown[]) => fetchPhotosMock(...args),
  };
});

vi.mock("./ThumbnailTile", () => ({
  ThumbnailTile: ({ photo }: { photo: PhotoItem }) => (
    <div data-testid="tile">{photo.path}</div>
  ),
}));

type MockObserver = {
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  trigger: (isIntersecting: boolean) => void;
};

const observers: MockObserver[] = [];

beforeAll(() => {
  class FakeIntersectionObserver {
    private callback: IntersectionObserverCallback;

    constructor(callback: IntersectionObserverCallback) {
      this.callback = callback;
      const mockObserver: MockObserver = {
        observe: vi.fn(),
        disconnect: vi.fn(),
        trigger: (isIntersecting: boolean) => {
          this.callback([
            {
              isIntersecting,
            } as IntersectionObserverEntry,
          ], this as unknown as IntersectionObserver);
        },
      };
      observers.push(mockObserver);
    }

    observe = vi.fn();
    disconnect = vi.fn();
  }

  // @ts-expect-error test override
  globalThis.IntersectionObserver = FakeIntersectionObserver;
});

const renderGrid = () =>
  render(
    <FilterProvider>
      <SelectionProvider>
        <ThumbnailGrid />
      </SelectionProvider>
    </FilterProvider>,
  );

describe("ThumbnailGrid", () => {
  beforeEach(() => {
    fetchPhotosMock.mockReset();
    observers.length = 0;
  });

  it("renders initial photos and then loads additional page with dedupe", async () => {
    fetchPhotosMock
      .mockResolvedValueOnce({
        items: [
          {
            path: "a/1.jpg",
            name: "1.jpg",
            mediaType: "photo",
            originalUrl: "u1",
            thumbnailUrl: "u1",
            previewUrl: "u1",
            fullUrl: "u1",
          },
        ],
        total: 3,
        page: 0,
        pageSize: 200,
      })
      .mockResolvedValueOnce({
        items: [
          {
            path: "a/1.jpg",
            name: "1.jpg",
            mediaType: "photo",
            originalUrl: "u1",
            thumbnailUrl: "u1",
            previewUrl: "u1",
            fullUrl: "u1",
          },
          {
            path: "a/2.jpg",
            name: "2.jpg",
            mediaType: "photo",
            originalUrl: "u2",
            thumbnailUrl: "u2",
            previewUrl: "u2",
            fullUrl: "u2",
          },
        ],
        total: 3,
        page: 1,
        pageSize: 200,
      });

    renderGrid();

    await waitFor(() => {
      expect(fetchPhotosMock).toHaveBeenCalledTimes(1);
      expect(screen.getAllByTestId("tile")).toHaveLength(1);
      expect(screen.getByText("a/1.jpg")).toBeInTheDocument();
      expect(observers.length).toBeGreaterThan(0);
    });

    await act(async () => {
      observers.forEach((observer) => observer.trigger(true));
    });

    await waitFor(() => {
      expect(fetchPhotosMock.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(screen.getAllByTestId("tile")).toHaveLength(2);
      expect(screen.getByText("a/2.jpg")).toBeInTheDocument();
    });
  });

  it("shows empty-state text when no items are returned", async () => {
    fetchPhotosMock.mockResolvedValueOnce({
      items: [],
      total: 0,
      page: 0,
      pageSize: 200,
    });

    renderGrid();

    expect(
      await screen.findByText("No photos yet. Upload some to get started."),
    ).toBeInTheDocument();
  });

  it("shows error text when loading fails", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    fetchPhotosMock.mockRejectedValueOnce(new Error("network down"));

    renderGrid();

    expect(await screen.findByText("Failed to fetch photos")).toBeInTheDocument();
    consoleErrorSpy.mockRestore();
  });
});
