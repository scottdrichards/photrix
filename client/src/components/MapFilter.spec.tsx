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
  useFilterContext: () => ({
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
}));

vi.mock("ol/Feature", () => ({
  default: class Feature {
    private geometry: { getCoordinates: () => number[] };

    constructor({ geometry }: { geometry: { getCoordinates: () => number[] } }) {
      this.geometry = geometry;
    }

    getGeometry() {
      return this.geometry;
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
    private features: Array<{ getGeometry: () => { getCoordinates: () => number[] } }> = [];

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

  it("updates filter bounds when map view filter is enabled", async () => {
    fetchGeotaggedPhotosMock.mockResolvedValueOnce({
      points: [],
      total: 0,
      truncated: false,
    });

    render(<MapFilter />);

    const toggle = await screen.findByRole("switch", {
      name: "Keep results synced to the current map view",
    });
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(setFilterMock).toHaveBeenCalledWith({
        locationBounds: {
          west: 10,
          east: 30,
          north: 40,
          south: 20,
        },
      });
    });
  });

  it("fits map view to pins when fit button is clicked", async () => {
    fetchGeotaggedPhotosMock.mockResolvedValueOnce({
      points: [{ path: "a/1.jpg", name: "1.jpg", latitude: 1, longitude: 2, count: 1 }],
      total: 1,
      truncated: false,
    });

    render(<MapFilter />);

    const button = await screen.findByRole("button", { name: "Fit to pins" });
    fireEvent.click(button);

    expect(fitSpy).toHaveBeenCalled();
  });

  it("shows error state when loading points fails", async () => {
    fetchGeotaggedPhotosMock.mockRejectedValueOnce(new Error("map load failed"));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(<MapFilter />);

    expect(await screen.findByText("map load failed")).toBeInTheDocument();
    errorSpy.mockRestore();
  });
});
