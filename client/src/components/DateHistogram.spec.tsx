import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DateHistogram } from "./DateHistogram";

const fetchDateHistogramMock = vi.fn();
const setFilterMock = vi.fn();
const useFilterContextMock = vi.fn();

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    fetchDateHistogram: (...args: unknown[]) => fetchDateHistogramMock(...args),
  };
});

vi.mock("./filter/FilterContext", () => ({
  useFilterContext: () => useFilterContextMock(),
}));

describe("DateHistogram", () => {
  beforeAll(() => {
    class FakeResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}

      observe = () => {
        this.callback(
          [{ contentRect: { width: 640 } } as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      };

      disconnect = () => undefined;
    }

    // @ts-expect-error test override
    globalThis.ResizeObserver = FakeResizeObserver;
  });

  beforeEach(() => {
    fetchDateHistogramMock.mockReset();
    setFilterMock.mockReset();
    useFilterContextMock.mockReturnValue({
      filter: {
        includeSubfolders: false,
        path: "",
        ratingFilter: null,
        mediaTypeFilter: "all",
        locationBounds: null,
        dateRange: null,
        peopleInImageFilter: [],
      },
      setFilter: setFilterMock,
    });
  });

  it("loads histogram data and renders date labels", async () => {
    fetchDateHistogramMock.mockResolvedValueOnce({
      buckets: [{ start: 1700000000000, end: 1700086400000, count: 2 }],
      bucketSizeMs: 86400000,
      minDate: 1700000000000,
      maxDate: 1700086400000,
      grouping: "day",
    });

    render(<DateHistogram label="Date range" />);

    expect(screen.getByText("Loading dates")).toBeInTheDocument();

    await waitFor(() => {
      expect(fetchDateHistogramMock).toHaveBeenCalledTimes(1);
      expect(screen.queryByText("Loading dates")).not.toBeInTheDocument();
    });
  });

  it("clears active date range via clear button", async () => {
    useFilterContextMock.mockReturnValue({
      filter: {
        includeSubfolders: false,
        path: "",
        ratingFilter: null,
        mediaTypeFilter: "all",
        locationBounds: null,
        dateRange: { start: 1700000000000, end: 1700086400000 },
        peopleInImageFilter: [],
      },
      setFilter: setFilterMock,
    });

    fetchDateHistogramMock.mockResolvedValueOnce({
      buckets: [{ start: 1700000000000, end: 1700086400000, count: 2 }],
      bucketSizeMs: 86400000,
      minDate: 1700000000000,
      maxDate: 1700086400000,
      grouping: "day",
    });

    render(<DateHistogram />);

    const clearButton = await screen.findByRole("button", { name: "Clear" });
    fireEvent.click(clearButton);

    expect(setFilterMock).toHaveBeenCalledWith({ dateRange: null });
  });

  it("renders error message when histogram fetch fails", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    fetchDateHistogramMock.mockRejectedValueOnce(new Error("histogram failed"));

    render(<DateHistogram />);

    expect(await screen.findByText("histogram failed")).toBeInTheDocument();
    consoleErrorSpy.mockRestore();
  });
});
