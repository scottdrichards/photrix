import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SearchInterpretation } from "../../../shared/filter-contract/src";
import { SearchBar } from "./SearchBar";
import { FilterProvider, useFilter } from "./filter/FilterContext";

const interpretSearchQuery = vi.hoisted(() => vi.fn());
vi.mock("../api/naturalLanguageSearch", () => ({ interpretSearchQuery }));

/** Surfaces the shared filter state so assertions can read what the bar set. */
const FilterProbe = () => {
  const { filter } = useFilter();
  return <pre data-testid="filter">{JSON.stringify(filter)}</pre>;
};

const currentFilter = (): Record<string, unknown> =>
  JSON.parse(screen.getByTestId("filter").textContent ?? "{}") as Record<string, unknown>;

const renderSearchBar = () =>
  render(
    <FilterProvider>
      <SearchBar />
      <FilterProbe />
    </FilterProvider>,
  );

const submit = (query: string) => {
  const input = screen.getByLabelText("Search your photos", { selector: "input" });
  fireEvent.change(input, { target: { value: query } });
  fireEvent.submit(input.closest("form")!);
};

const interpretation: SearchInterpretation = {
  interpreted: true,
  query: "photos of Sarah at the beach last summer",
  filter: {
    faceClusterFilter: ["person-12"],
    mediaTypeFilter: "photo",
    dateRange: { start: Date.UTC(2025, 5, 1), end: Date.UTC(2025, 8, 1) - 1 },
    semanticQuery: "at the beach",
  },
  chips: [
    { field: "faceClusterFilter", label: "Sarah", value: "person-12" },
    { field: "mediaTypeFilter", label: "Photos only" },
    { field: "dateRange", label: "Summer 2025" },
    { field: "semanticQuery", label: "“at the beach”" },
  ],
  ignored: [],
};

describe("SearchBar natural-language interpretation", () => {
  beforeEach(() => {
    interpretSearchQuery.mockReset();
    window.localStorage.clear();
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: true,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  it("runs the plain search immediately on submit, before any interpretation", () => {
    // A promise that never settles: the plain search must not wait on the model.
    interpretSearchQuery.mockReturnValue(new Promise(() => {}));
    renderSearchBar();

    submit("photos of Sarah at the beach last summer");

    expect(currentFilter().semanticQuery).toBe(
      "photos of Sarah at the beach last summer",
    );
    expect(screen.queryByText("AI search")).not.toBeInTheDocument();
  });

  it("leaves the plain search untouched when Ollama is unavailable", async () => {
    interpretSearchQuery.mockResolvedValue({
      interpreted: false,
      reason: "unavailable",
    });
    renderSearchBar();

    submit("photos of Sarah at the beach last summer");

    await waitFor(() => expect(interpretSearchQuery).toHaveBeenCalled());
    expect(currentFilter().semanticQuery).toBe(
      "photos of Sarah at the beach last summer",
    );
    expect(screen.queryByText("AI search")).not.toBeInTheDocument();
    expect(currentFilter().faceClusterFilter).toBeUndefined();
  });

  it("applies derived filters and shows them as removable chips", async () => {
    interpretSearchQuery.mockResolvedValue(interpretation);
    renderSearchBar();

    submit("photos of Sarah at the beach last summer");

    await screen.findByText("AI search");
    const filter = currentFilter();
    expect(filter.faceClusterFilter).toEqual(["person-12"]);
    expect(filter.mediaTypeFilter).toBe("photo");
    expect(filter.dateRange).toEqual({
      start: Date.UTC(2025, 5, 1),
      end: Date.UTC(2025, 8, 1) - 1,
    });
    // Only the leftover description reaches CLIP.
    expect(filter.semanticQuery).toBe("at the beach");
    expect(screen.getByText("Sarah")).toBeInTheDocument();
    expect(screen.getByText("Summer 2025")).toBeInTheDocument();
  });

  it("clears the semantic query when nothing visual is left over", async () => {
    interpretSearchQuery.mockResolvedValue({
      interpreted: true,
      query: "videos from the Trips folder",
      filter: { path: "Trips/", includeSubfolders: true, mediaTypeFilter: "video" },
      chips: [
        { field: "path", label: "Folder: Trips" },
        { field: "mediaTypeFilter", label: "Videos only" },
      ],
      ignored: [],
    } satisfies SearchInterpretation);
    renderSearchBar();

    submit("videos from the Trips folder");

    await screen.findByText("AI search");
    const filter = currentFilter();
    expect(filter.path).toBe("Trips/");
    expect(filter.semanticQuery).toBeUndefined();
  });

  it("names filters it could not ground in the library", async () => {
    interpretSearchQuery.mockResolvedValue({
      ...interpretation,
      ignored: ["Gandalf"],
    } satisfies SearchInterpretation);
    renderSearchBar();

    submit("photos of Sarah and Gandalf");

    await screen.findByText(/ignored: Gandalf/);
  });

  it("removes a single derived filter without disturbing the others", async () => {
    interpretSearchQuery.mockResolvedValue(interpretation);
    renderSearchBar();

    submit("photos of Sarah at the beach last summer");
    await screen.findByText("AI search");

    fireEvent.click(screen.getByLabelText("Remove filter Sarah"));

    const filter = currentFilter();
    expect(filter.faceClusterFilter).toBeUndefined();
    expect(filter.mediaTypeFilter).toBe("photo");
    expect(filter.dateRange).toBeDefined();
    expect(screen.queryByLabelText("Remove filter Sarah")).not.toBeInTheDocument();
    expect(screen.getByText("Summer 2025")).toBeInTheDocument();
  });

  it("undoes the whole interpretation back to a plain search", async () => {
    interpretSearchQuery.mockResolvedValue(interpretation);
    renderSearchBar();

    submit("photos of Sarah at the beach last summer");
    await screen.findByText("AI search");

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));

    const filter = currentFilter();
    expect(filter.semanticQuery).toBe("photos of Sarah at the beach last summer");
    expect(filter.faceClusterFilter).toBeUndefined();
    // Restored to the pre-search value, not blanked.
    expect(filter.mediaTypeFilter).toBe("all");
    expect(filter.dateRange).toBeUndefined();
    expect(screen.queryByText("AI search")).not.toBeInTheDocument();
  });

  it("clearing the search also drops the derived filters", async () => {
    interpretSearchQuery.mockResolvedValue(interpretation);
    renderSearchBar();

    submit("photos of Sarah at the beach last summer");
    await screen.findByText("AI search");

    fireEvent.click(screen.getByLabelText("Clear search"));

    const filter = currentFilter();
    expect(filter.semanticQuery).toBeUndefined();
    expect(filter.faceClusterFilter).toBeUndefined();
    expect(screen.queryByText("AI search")).not.toBeInTheDocument();
  });

  it("ignores an interpretation that arrives after the query moved on", async () => {
    let resolveFirst: (value: SearchInterpretation) => void = () => {};
    interpretSearchQuery
      .mockReturnValueOnce(
        new Promise<SearchInterpretation>((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockResolvedValueOnce({ interpreted: false, reason: "no-filters" });
    renderSearchBar();

    submit("photos of Sarah at the beach last summer");
    submit("sunset over water");

    resolveFirst(interpretation);
    await waitFor(() => expect(interpretSearchQuery).toHaveBeenCalledTimes(2));

    expect(currentFilter().semanticQuery).toBe("sunset over water");
    expect(currentFilter().faceClusterFilter).toBeUndefined();
    expect(screen.queryByText("AI search")).not.toBeInTheDocument();
  });

  it("does not call the model for an empty submit", () => {
    interpretSearchQuery.mockResolvedValue({ interpreted: false, reason: "empty-query" });
    renderSearchBar();

    submit("   ");

    expect(interpretSearchQuery).not.toHaveBeenCalled();
    expect(currentFilter().semanticQuery).toBeUndefined();
  });

  it("skips the model entirely when AI search is toggled off (feedback #102)", () => {
    interpretSearchQuery.mockResolvedValue(interpretation);
    renderSearchBar();

    fireEvent.click(screen.getByTitle("AI search: on"));
    submit("photos of Sarah at the beach last summer");

    expect(interpretSearchQuery).not.toHaveBeenCalled();
    expect(currentFilter().semanticQuery).toBe(
      "photos of Sarah at the beach last summer",
    );
  });

  it("reverts an active interpretation when AI search is turned off mid-search", async () => {
    interpretSearchQuery.mockResolvedValue(interpretation);
    renderSearchBar();

    submit("photos of Sarah at the beach last summer");
    await screen.findByText("AI search");

    fireEvent.click(screen.getByTitle("AI search: on"));

    expect(screen.queryByText("AI search")).not.toBeInTheDocument();
    expect(currentFilter().faceClusterFilter).toBeUndefined();
    expect(currentFilter().semanticQuery).toBe(
      "photos of Sarah at the beach last summer",
    );
  });

  it("remembers the AI search preference across remounts", () => {
    interpretSearchQuery.mockResolvedValue(interpretation);
    const { unmount } = renderSearchBar();

    fireEvent.click(screen.getByTitle("AI search: on"));
    unmount();

    renderSearchBar();
    submit("photos of Sarah at the beach last summer");

    expect(interpretSearchQuery).not.toHaveBeenCalled();
  });
});
