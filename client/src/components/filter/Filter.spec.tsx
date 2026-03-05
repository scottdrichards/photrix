import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Filter } from "./Filter";
import { FilterProvider, useFilterContext } from "./FilterContext";

const fetchFoldersMock = vi.fn();
const fetchSuggestionsMock = vi.fn();

vi.mock("../../api", async () => {
  const actual = await vi.importActual<typeof import("../../api")>("../../api");
  return {
    ...actual,
    fetchFolders: (...args: unknown[]) => fetchFoldersMock(...args),
    fetchSuggestions: (...args: unknown[]) => fetchSuggestionsMock(...args),
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
    fetchSuggestionsMock.mockReset();
    fetchFoldersMock.mockResolvedValue(["trip", "family"]);
    fetchSuggestionsMock.mockResolvedValue([]);
    window.history.pushState(null, "", "/");
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
