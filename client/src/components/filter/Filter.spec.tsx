import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Filter } from "./Filter";
import { FilterProvider, useFilterContext } from "./FilterContext";

const fetchFoldersMock = vi.fn();
const fetchSuggestionsWithCountsMock = vi.fn();

vi.mock("../../api", async () => {
  const actual = await vi.importActual<typeof import("../../api")>("../../api");
  return {
    ...actual,
    fetchFolders: (...args: unknown[]) => fetchFoldersMock(...args),
    fetchSuggestionsWithCounts: (...args: unknown[]) =>
      fetchSuggestionsWithCountsMock(...args),
  };
});

vi.mock("../DateHistogram", () => ({
  DateHistogram: () => <div data-testid="date-histogram">date-histogram</div>,
}));

vi.mock("../MapFilter", () => ({
  MapFilter: () => <div data-testid="map-filter">map-filter</div>,
}));

const FilterStateProbe = () => {
  const { filter } = useFilterContext();
  return <pre data-testid="filter-state">{JSON.stringify(filter)}</pre>;
};

const FilterStateMutator = () => {
  const { setFilter } = useFilterContext();

  return (
    <button
      type="button"
      onClick={() =>
        setFilter({
          locationBounds: {
            west: -122.4,
            south: 37.7,
            east: -122.3,
            north: 37.8,
          },
        })
      }
    >
      Enable map filter
    </button>
  );
};

const renderFilter = () =>
  render(
    <FilterProvider>
      <Filter />
      <FilterStateProbe />
    </FilterProvider>,
  );

describe("Filter", () => {
  beforeEach(() => {
    fetchFoldersMock.mockReset();
    fetchFoldersMock.mockResolvedValue(["trip", "family"]);
    fetchSuggestionsWithCountsMock.mockResolvedValue([]);
    window.history.pushState(null, "", "/");
  });

  it("shows top people suggestions with counts before typing", async () => {
    fetchSuggestionsWithCountsMock.mockResolvedValue([
      { value: "Sam", count: 14 },
      { value: "Taylor", count: 9 },
    ]);

    renderFilter();

    fireEvent.click(screen.getByRole("button", { name: "People in image filter" }));

    expect(
      await screen.findByRole("button", { name: /Sam\s*\(14\)/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Taylor\s*\(9\)/ })).toBeInTheDocument();
    expect(fetchSuggestionsWithCountsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        field: "personInImage",
        q: "",
        allowBlankQuery: true,
        includeCounts: true,
      }),
    );
  });

  it("shows top camera and lens suggestions with counts before typing", async () => {
    fetchSuggestionsWithCountsMock.mockImplementation(
      ({ field }: { field: string }) => {
        if (field === "cameraModel") {
          return Promise.resolve([{ value: "Canon EOS R6", count: 18 }]);
        }
        if (field === "lens") {
          return Promise.resolve([{ value: "RF 24-70mm F2.8", count: 11 }]);
        }
        return Promise.resolve([]);
      },
    );

    renderFilter();

    fireEvent.click(screen.getByRole("button", { name: "Camera and lens filter" }));

    expect(
      await screen.findByRole("button", { name: /Canon EOS R6\s*\(18\)/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /RF 24-70mm F2.8\s*\(11\)/ }),
    ).toBeInTheDocument();
    expect(fetchSuggestionsWithCountsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        field: "cameraModel",
        q: "",
        allowBlankQuery: true,
        includeCounts: true,
      }),
    );
    expect(fetchSuggestionsWithCountsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        field: "lens",
        q: "",
        allowBlankQuery: true,
        includeCounts: true,
      }),
    );
  });

  it("updates media type through media type panel", async () => {
    renderFilter();

    fireEvent.click(screen.getByRole("button", { name: "Media type filter" }));
    fireEvent.click(await screen.findByRole("button", { name: "Video" }));

    await waitFor(() => {
      expect(screen.getByTestId("filter-state").textContent).toContain(
        '"mediaTypeFilter":"video"',
      );
    });
  });

  it("shows rating counts and applies selected rating", async () => {
    const localizedTwelveThousand = new Intl.NumberFormat().format(12000);
    fetchSuggestionsWithCountsMock.mockImplementation(
      ({ field }: { field: string }) => {
        if (field === "rating") {
          return Promise.resolve([
            { value: "5", count: 12000 },
            { value: "4", count: 8 },
            { value: "3", count: 5 },
            { value: "2", count: 2 },
            { value: "1", count: 1 },
          ]);
        }
        return Promise.resolve([]);
      },
    );

    renderFilter();

    fireEvent.click(screen.getByRole("button", { name: "Rating filter" }));

    await waitFor(() => {
      const ratingButtons = screen.getAllByRole("button");
      const fiveStarCountButton = ratingButtons.find((button) => {
        const text = button.textContent ?? "";
        return text.includes("★★★★★") && text.includes(localizedTwelveThousand);
      });
      expect(fiveStarCountButton).toBeDefined();
    });
    fireEvent.click(screen.getByRole("button", { name: /★★★☆☆\s*\(5\)/ }));

    await waitFor(() => {
      expect(screen.getByTestId("filter-state").textContent).toContain(
        '"ratingFilter":{"rating":3,"atLeast":true}',
      );
    });
  });

  it("adds person filter when Enter is pressed in people input", async () => {
    renderFilter();

    fireEvent.click(screen.getByRole("button", { name: "People in image filter" }));

    const input = await screen.findByPlaceholderText("Search names (e.g. Scott)");
    fireEvent.change(input, { target: { value: "Sam" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByText("Sam ×")).toBeInTheDocument();
      expect(screen.getByTestId("filter-state").textContent).toContain(
        '"peopleInImageFilter":["Sam"]',
      );
    });
  });

  it("adds camera model and lens model filters", async () => {
    renderFilter();

    fireEvent.click(screen.getByRole("button", { name: "Camera and lens filter" }));

    const cameraInput = await screen.findByPlaceholderText(
      "Search camera model (e.g. R6 Mark II)",
    );
    fireEvent.change(cameraInput, { target: { value: "Canon EOS R6" } });
    fireEvent.keyDown(cameraInput, { key: "Enter" });

    const lensInput = await screen.findByPlaceholderText(
      "Search lens model (e.g. RF 24-70mm F2.8)",
    );
    fireEvent.change(lensInput, { target: { value: "RF 24-70mm F2.8 L IS USM" } });
    fireEvent.keyDown(lensInput, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByText("Canon EOS R6 ×")).toBeInTheDocument();
      expect(screen.getByText("RF 24-70mm F2.8 L IS USM ×")).toBeInTheDocument();
      expect(screen.getByTestId("filter-state").textContent).toContain(
        '"cameraModelFilter":["Canon EOS R6"]',
      );
      expect(screen.getByTestId("filter-state").textContent).toContain(
        '"lensFilter":["RF 24-70mm F2.8 L IS USM"]',
      );
    });
  });

  it("navigates into clicked folder", async () => {
    renderFilter();

    fireEvent.click(screen.getByRole("button", { name: "Folders filter" }));
    fireEvent.click(await screen.findByText("trip"));

    await waitFor(() => {
      expect(screen.getByTestId("filter-state").textContent).toContain('"path":"trip/"');
    });
  });

  it("keeps active indicator on filter icons after panel closes", async () => {
    render(
      <FilterProvider>
        <Filter />
        <FilterStateMutator />
      </FilterProvider>,
    );

    const mapFilterButton = screen.getByRole("button", { name: "Map filter" });
    expect(mapFilterButton).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(screen.getByRole("button", { name: "Enable map filter" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Map filter" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Media type filter" }));
    fireEvent.click(await screen.findByRole("button", { name: "Video" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Media type filter" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
  });
});
