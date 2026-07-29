import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MapFilter } from "./MapFilter";

const fetchGeotaggedPhotosMock = vi.fn();
const setFilterMock = vi.fn();
let currentFilter: Record<string, unknown>;

const fitSpy = vi.fn();
const setCenterSpy = vi.fn();
const setZoomSpy = vi.fn();

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    fetchGeotaggedPhotos: (...args: unknown[]) => fetchGeotaggedPhotosMock(...args),
  };
});

vi.mock("./filter/FilterContext", () => ({
  useFilter: () => ({
    filter: currentFilter,
    setFilter: setFilterMock,
  }),
}));

vi.mock("./MapFilter.styles", () => ({
  useMapFilterStyles: () => ({
    card: "card",
    compactCard: "compactCard",
    headerRow: "headerRow",
    description: "description",
    actions: "actions",
    mapShell: "mapShell",
    map: "map",
    compactMap: "compactMap",
    overlay: "overlay",
    statusRow: "statusRow",
    error: "error",
  }),
  markerStyle: {},
  markerStyleFor: vi.fn(() => ({})),
  movementPathStyle: {},
}));

vi.mock("ol/Feature", () => ({
  default: class Feature {
    private geometry: { getCoordinates: () => number[] };
    private props = new Map<string, unknown>();

    constructor({ geometry }: { geometry: { getCoordinates: () => number[] } }) {
      this.geometry = geometry;
    }

    getGeometry() {
      return this.geometry;
    }

    set(key: string, value: unknown) {
      this.props.set(key, value);
    }

    get(key: string) {
      return this.props.get(key);
    }
  },
}));

vi.mock("ol/Overlay", () => ({
  default: class MockOverlay {
    private element: HTMLElement;

    constructor({ element }: { element: HTMLElement }) {
      this.element = element;
    }

    getElement() {
      return this.element;
    }

    setPosition = vi.fn();
  },
}));

vi.mock("ol/geom/LineString", () => ({
  default: class LineString {
    private coordinates: number[][];

    constructor(coordinates: number[][]) {
      this.coordinates = coordinates;
    }

    getCoordinates() {
      return this.coordinates;
    }
  },
}));

vi.mock("ol/Map", () => ({
  default: class MockMap {
    private state = new Map<string, unknown>();
    private view: {
      calculateExtent: () => number[];
      fit: typeof fitSpy;
      setCenter: typeof setCenterSpy;
      setZoom: typeof setZoomSpy;
    };

    constructor({ view }: { view: MockMap["view"] }) {
      this.view = view;
    }

    updateSize = vi.fn();
    getSize = vi.fn(() => [800, 600]);
    getView = vi.fn(() => this.view);
    // Identity-ish projection: the ol/proj mock passes lon/lat through, so a
    // pin's "pixel" is just its coordinate. Enough to exercise the pixel-space
    // thinning without a real map.
    getPixelFromCoordinate = vi.fn((coordinate: number[]) => coordinate);
    // The real addOverlay attaches the overlay's element to the map container;
    // markers are portalled into that element, so it has to be in the document.
    addOverlay = vi.fn((overlay: { getElement: () => HTMLElement }) => {
      document.body.appendChild(overlay.getElement());
    });

    removeOverlay = vi.fn((overlay: { getElement: () => HTMLElement }) => {
      overlay.getElement().remove();
    });
    on = vi.fn();
    un = vi.fn();
    setTarget = vi.fn();
    getViewport = vi.fn(() => ({
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));

    set = vi.fn((key: string, value: unknown) => {
      this.state.set(key, value);
    });

    get = vi.fn((key: string) => this.state.get(key));
  },
}));

vi.mock("ol/View", () => ({
  default: class MockView {
    calculateExtent = vi.fn(() => [10, 20, 30, 40]);
    getZoom = vi.fn(() => 4);
    fit = fitSpy;
    setCenter = setCenterSpy;
    setZoom = setZoomSpy;
  },
}));

vi.mock("ol/extent", () => ({
  boundingExtent: vi.fn(() => [0, 0, 5, 5]),
}));

vi.mock("ol/geom/Point", () => ({
  default: class Point {
    private coordinates: number[];

    constructor(coordinates: number[]) {
      this.coordinates = coordinates;
    }

    getCoordinates() {
      return this.coordinates;
    }
  },
}));

vi.mock("ol/layer/Tile", () => ({
  default: class TileLayer {
    constructor(_: unknown) {}
  },
}));

vi.mock("ol/layer/Vector", () => ({
  default: class VectorLayer {
    constructor(_: unknown) {}
  },
}));

vi.mock("ol/proj", () => ({
  fromLonLat: vi.fn((coords: number[]) => coords),
  transformExtent: vi.fn((extent: number[]) => extent),
}));

vi.mock("ol/source/OSM", () => ({
  default: class OSM {
    constructor() {}
  },
}));

vi.mock("ol/source/Vector", () => ({
  default: class VectorSource {
    private features: Array<{ getGeometry: () => { getCoordinates: () => number[] } }> =
      [];

    clear = vi.fn(() => {
      this.features = [];
    });

    addFeatures = vi.fn(
      (features: Array<{ getGeometry: () => { getCoordinates: () => number[] } }>) => {
        this.features = features;
      },
    );

    getExtent = vi.fn(() => [0, 0, 5, 5]);
    getFeatures = vi.fn(() => this.features);
  },
}));

describe("MapFilter", () => {
  beforeAll(() => {
    class FakeResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}

      observe = () => {
        this.callback([], this as unknown as ResizeObserver);
      };

      disconnect = () => undefined;
    }

    // @ts-expect-error test override
    globalThis.ResizeObserver = FakeResizeObserver;
  });

  beforeEach(() => {
    fetchGeotaggedPhotosMock.mockReset();
    setFilterMock.mockReset();
    fitSpy.mockReset();
    setCenterSpy.mockReset();
    setZoomSpy.mockReset();

    currentFilter = {
      includeSubfolders: false,
      path: "",
      mediaTypeFilter: "all",
      ratingFilter: null,
      locationBounds: undefined,
      dateRange: null,
      peopleInImageFilter: [],
    };
  });

  it("loads points and renders pin summary", async () => {
    fetchGeotaggedPhotosMock.mockResolvedValueOnce({
      points: [{ path: "a/1.jpg", name: "1.jpg", latitude: 1, longitude: 2, count: 1 }],
      total: 2,
      truncated: true,
    });

    render(<MapFilter compact />);

    expect(await screen.findByText("1 of 2 pins (limited)")).toBeInTheDocument();
    expect(
      screen.getByText("Limited to current slice for performance."),
    ).toBeInTheDocument();
  });

  it("shows clear map filter button when locationBounds is set", async () => {
    currentFilter = {
      ...currentFilter,
      locationBounds: { north: 40, south: 20, east: 30, west: 10 },
    };
    fetchGeotaggedPhotosMock.mockResolvedValueOnce({
      points: [{ path: "a/1.jpg", name: "1.jpg", latitude: 1, longitude: 2, count: 1 }],
      total: 1,
      truncated: false,
    });

    render(<MapFilter />);

    expect(
      await screen.findByRole("button", { name: "Clear map filter" }),
    ).toBeInTheDocument();
  });

  it("fits map to filter bounds immediately on mount", async () => {
    currentFilter = {
      ...currentFilter,
      locationBounds: { north: 40, south: 20, east: 30, west: 10 },
    };
    fetchGeotaggedPhotosMock.mockResolvedValueOnce({
      points: [],
      total: 0,
      truncated: false,
    });

    render(<MapFilter />);

    await waitFor(() => {
      expect(fitSpy).toHaveBeenCalledWith(
        [10, 20, 30, 40],
        expect.objectContaining({ padding: [24, 24, 24, 24], maxZoom: 20 }),
      );
    });
  });

  it("does not show clear map filter button when no locationBounds", async () => {
    fetchGeotaggedPhotosMock.mockResolvedValueOnce({
      points: [{ path: "a/1.jpg", name: "1.jpg", latitude: 1, longitude: 2, count: 1 }],
      total: 1,
      truncated: false,
    });

    render(<MapFilter />);

    await screen.findByText("1 of 1 pins");
    expect(
      screen.queryByRole("button", { name: "Clear map filter" }),
    ).not.toBeInTheDocument();
  });

  it("clears location bounds when clear button is clicked", async () => {
    currentFilter = {
      ...currentFilter,
      locationBounds: { north: 40, south: 20, east: 30, west: 10 },
    };
    fetchGeotaggedPhotosMock.mockResolvedValueOnce({
      points: [{ path: "a/1.jpg", name: "1.jpg", latitude: 1, longitude: 2, count: 1 }],
      total: 1,
      truncated: false,
    });

    render(<MapFilter />);

    const button = await screen.findByRole("button", { name: "Clear map filter" });
    fireEvent.click(button);

    await waitFor(() => {
      expect(setFilterMock).toHaveBeenCalledWith({ locationBounds: undefined });
    });
  });

  it("shows error state when loading points fails", async () => {
    fetchGeotaggedPhotosMock.mockRejectedValueOnce(new Error("map load failed"));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(<MapFilter />);

    expect(await screen.findByText("map load failed")).toBeInTheDocument();
    errorSpy.mockRestore();
  });

  describe("fullscreen exploration", () => {
    // Far enough apart in the identity projection to clear the separation floor.
    const spreadPoints = [
      { path: "a/1.jpg", name: "1.jpg", latitude: 100, longitude: 100, count: 9 },
      { path: "a/2.jpg", name: "2.jpg", latitude: 400, longitude: 400, count: 4 },
    ];

    it("shows representative photos only once fullscreen is entered", async () => {
      fetchGeotaggedPhotosMock.mockResolvedValue({
        points: spreadPoints,
        total: 2,
        truncated: false,
      });

      render(<MapFilter compact />);
      await screen.findByText("2 of 2 pins");

      expect(screen.queryByRole("button", { name: /^Zoom to/ })).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Explore fullscreen" }));

      await waitFor(() => {
        expect(screen.getAllByRole("button", { name: /^Zoom to/ })).toHaveLength(2);
      });
    });

    it("drops the representatives again on exit", async () => {
      fetchGeotaggedPhotosMock.mockResolvedValue({
        points: spreadPoints,
        total: 2,
        truncated: false,
      });

      render(<MapFilter compact />);
      await screen.findByText("2 of 2 pins");
      fireEvent.click(screen.getByRole("button", { name: "Explore fullscreen" }));
      await screen.findAllByRole("button", { name: /^Zoom to/ });

      fireEvent.click(screen.getByRole("button", { name: "Exit fullscreen" }));

      await waitFor(() => {
        expect(screen.queryByRole("button", { name: /^Zoom to/ })).toBeNull();
      });
    });

    it("zooms to a pin when its photo is clicked", async () => {
      fetchGeotaggedPhotosMock.mockResolvedValue({
        points: spreadPoints,
        total: 2,
        truncated: false,
      });

      render(<MapFilter compact />);
      await screen.findByText("2 of 2 pins");
      fireEvent.click(screen.getByRole("button", { name: "Explore fullscreen" }));

      const markers = await screen.findAllByRole("button", { name: /^Zoom to/ });
      fireEvent.click(markers[0]);

      expect(setCenterSpy).toHaveBeenCalled();
      // Never zooms out: the view mock reports 4, the floor is 14.
      expect(setZoomSpy).toHaveBeenCalledWith(14);
    });

    it("leaves fullscreen on Escape", async () => {
      fetchGeotaggedPhotosMock.mockResolvedValue({
        points: spreadPoints,
        total: 2,
        truncated: false,
      });

      render(<MapFilter compact />);
      await screen.findByText("2 of 2 pins");
      fireEvent.click(screen.getByRole("button", { name: "Explore fullscreen" }));
      await screen.findByRole("button", { name: "Exit fullscreen" });

      fireEvent.keyDown(window, { key: "Escape" });

      expect(
        await screen.findByRole("button", { name: "Explore fullscreen" }),
      ).toBeInTheDocument();
    });
  });

  it("toggles the chronological movement path", async () => {
    fetchGeotaggedPhotosMock.mockResolvedValue({
      points: [
        { path: "a/1.jpg", name: "1.jpg", latitude: 1, longitude: 2, count: 1 },
        { path: "a/2.jpg", name: "2.jpg", latitude: 3, longitude: 4, count: 1 },
      ],
      total: 2,
      truncated: false,
    });

    render(<MapFilter compact />);
    await screen.findByText("2 of 2 pins");

    const toggle = screen.getByTitle("Trace these pins in date order");
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
  });
});
