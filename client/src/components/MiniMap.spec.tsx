import React from "react";
import { render } from "@testing-library/react";
import { MiniMap } from "./MiniMap";

const animateSpy = vi.fn();

vi.mock("ol/Map", () => ({
  default: class MockMap {
    private state = new Map<string, unknown>();
    private view: {
      animate: typeof animateSpy;
    };

    constructor({ view, target, layers }: { view: MockMap["view"]; target?: HTMLElement; layers?: unknown[] }) {
      this.view = view;
    }

    updateSize = vi.fn();
    getSize = vi.fn(() => [800, 600]);
    getView = vi.fn(() => this.view);
    setTarget = vi.fn();
  },
}));

vi.mock("ol/View", () => ({
  default: class MockView {
    animate = animateSpy;
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
    getSource = vi.fn(() => ({
      clear: vi.fn(),
      addFeatures: vi.fn(),
    }));
  },
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

vi.mock("ol/source/OSM", () => ({
  default: class OSM {
    constructor() {}
  },
}));

vi.mock("ol/source/Vector", () => ({
  default: class VectorSource {
    clear = vi.fn();
    addFeatures = vi.fn();
    getFeatures = vi.fn(() => []);
  },
}));

vi.mock("ol/proj", () => ({
  fromLonLat: vi.fn((coords: number[]) => coords),
}));

vi.mock("./MapFilter.styles", () => ({
  markerStyle: {},
}));

vi.mock("./MiniMap.module.css", () => ({
  default: {
    mapContainer: "mapContainer",
    label: "label",
    miniMap: "miniMap",
  },
}));

describe("MiniMap", () => {
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
    animateSpy.mockReset();
  });

  it("does not render when location is not available", () => {
    const { container } = render(<MiniMap />);
    expect(container.firstChild).toBeNull();
  });

  it("renders mini map when location is available", () => {
    const { container } = render(<MiniMap latitude={40} longitude={30} />);
    expect(container.firstChild).not.toBeNull();
  });

  it("renders map with location label", () => {
    const { getByText } = render(<MiniMap latitude={40} longitude={30} />);
    expect(getByText("Location")).toBeInTheDocument();
  });
});
