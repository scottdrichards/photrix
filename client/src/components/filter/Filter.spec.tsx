import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { Filter } from "./Filter";
import { FilterProvider, useFilter, type FilterState } from "./FilterContext";

const fetchFoldersMock = vi.fn();
const fetchSuggestionsWithCountsMock = vi.fn();
const fetchPeopleClustersMock = vi.fn();

vi.mock("../../api", async () => {
  const actual = await vi.importActual<typeof import("../../api")>("../../api");
  return {
    ...actual,
    fetchFolders: (...args: unknown[]) => fetchFoldersMock(...args),
    fetchSuggestionsWithCounts: (...args: unknown[]) =>
      fetchSuggestionsWithCountsMock(...args),
    fetchPeopleClusters: (...args: unknown[]) => fetchPeopleClustersMock(...args),
  };
});

vi.mock("../DateHistogram", () => ({
  DateHistogram: () => <div data-testid="date-histogram">date-histogram</div>,
}));

vi.mock("../MapFilter", () => ({
  MapFilter: () => <div data-testid="map-filter">map-filter</div>,
}));

const FilterStateProbe = () => {
  const { filter } = useFilter();
  return <pre data-testid="filter-state">{JSON.stringify(filter)}</pre>;
};

const FilterStateMutator = () => {
  const { setFilter } = useFilter();

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

const FilterStateInitializer = ({ nextFilter }: { nextFilter: Partial<FilterState> }) => {
  const { setFilter } = useFilter();

  useEffect(() => {
    setFilter(nextFilter);
  }, [nextFilter, setFilter]);

  return null;
};

const renderFilter = () =>
  render(
    <FilterProvider>
      <Filter />
      <FilterStateProbe />
    </FilterProvider>,
  );

describe("Filter", () => {
  let getBoundingClientRectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchFoldersMock.mockReset();
    fetchFoldersMock.mockResolvedValue([
      { name: "trip", count: 7 },
      { name: "family", count: 2 },
    ]);
    fetchSuggestionsWithCountsMock.mockResolvedValue([]);
    fetchPeopleClustersMock.mockReset();
    fetchPeopleClustersMock.mockResolvedValue({
      clusters: [
        {
          id: "person-3",
          count: 7,
          name: null,
          representative: {
            photo: { path: "trip/a.jpg", name: "a.jpg" },
            box: { x: 0.5, y: 0.5, width: 0.2, height: 0.2 },
          },
        },
      ],
      totalFaces: 7,
      totalClusters: 1,
      pendingFaces: 0,
    });
    window.history.pushState(null, "", "/");
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1024,
    });

    getBoundingClientRectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(
        () =>
          ({
            x: 0,
            y: 0,
            width: 36,
            height: 36,
            top: 100,
            right: 80,
            bottom: 136,
            left: 44,
            toJSON: () => ({}),
          }) as DOMRect,
      );
  });

  afterEach(() => {
    getBoundingClientRectSpy.mockRestore();
  });

  it("passes an abort signal to fetchFolders", async () => {
    renderFilter();

    await waitFor(() => {
      expect(fetchFoldersMock).toHaveBeenCalledWith(
        expect.objectContaining({ path: "", signal: expect.any(AbortSignal) }),
      );
    });
  });

  it("does not re-request folders on each rerender when optional array filters are unset", async () => {
    fetchFoldersMock.mockImplementation(() => new Promise(() => {}));

    renderFilter();

    await waitFor(() => {
      expect(fetchFoldersMock).toHaveBeenCalledTimes(1);
    });

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(fetchFoldersMock).toHaveBeenCalledTimes(1);
  });

  it("scopes folders to the active non-folder filters and shows counts", async () => {
    render(
      <FilterProvider>
        <FilterStateInitializer
          nextFilter={{
            mediaTypeFilter: "video",
            ratingFilter: { rating: 4, atLeast: true },
            peopleInImageFilter: ["Sam"],
          }}
        />
        <Filter />
        <FilterStateProbe />
      </FilterProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Folders filter" }));

    // The count renders in its own nested <span> (for the muted color
    // treatment), so it's a separate text node from the folder name rather
    // than one combined string.
    expect(await screen.findByText("trip")).toBeInTheDocument();
    expect(screen.getByText("(7)")).toBeInTheDocument();
    expect(screen.getByText("family")).toBeInTheDocument();
    expect(screen.getByText("(2)")).toBeInTheDocument();
    expect(fetchFoldersMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaTypeFilter: "video",
        ratingFilter: { rating: 4, atLeast: true },
        peopleInImageFilter: ["Sam"],
      }),
    );
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
    fetchSuggestionsWithCountsMock.mockImplementation(({ field }: { field: string }) => {
      if (field === "cameraModel") {
        return Promise.resolve([{ value: "Canon EOS R6", count: 18 }]);
      }
      if (field === "lens") {
        return Promise.resolve([{ value: "RF 24-70mm F2.8", count: 11 }]);
      }
      return Promise.resolve([]);
    });

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

  it("cycles the photo and video filter directly from the toolbar button", async () => {
    renderFilter();

    const mediaTypeButton = screen.getByRole("button", { name: "Media type filter" });

    fireEvent.click(mediaTypeButton);

    await waitFor(() => {
      expect(screen.getByTestId("filter-state").textContent).toContain(
        '"mediaTypeFilter":"photo"',
      );
    });

    fireEvent.click(mediaTypeButton);

    await waitFor(() => {
      expect(screen.getByTestId("filter-state").textContent).toContain(
        '"mediaTypeFilter":"video"',
      );
    });

    fireEvent.click(mediaTypeButton);

    await waitFor(() => {
      expect(screen.getByTestId("filter-state").textContent).toContain(
        '"mediaTypeFilter":"all"',
      );
    });
  });

  it("selects a clustered face from the People face panel", async () => {
    renderFilter();

    fireEvent.click(screen.getByRole("button", { name: "People face filter" }));

    const faceButton = await screen.findByRole("button", { name: "7 faces" });
    fireEvent.click(faceButton);

    await waitFor(() => {
      expect(screen.getByTestId("filter-state").textContent).toContain(
        '"faceClusterFilter":["person-3"]',
      );
    });

    fireEvent.click(faceButton);

    await waitFor(() => {
      expect(screen.getByTestId("filter-state").textContent).toContain(
        '"faceClusterFilter":null',
      );
    });
  });

  it("shows the People face icon as active for a photo-ready attribute filter with no person selected", async () => {
    render(
      <FilterProvider>
        <Filter />
        <FilterStateInitializer
          nextFilter={{
            faceAttributeFilter: { attributes: ["smiling", "eyesOpen"] },
          }}
        />
      </FilterProvider>,
    );

    const faceFilterButton = await screen.findByRole("button", {
      name: "People face filter",
    });

    // "Photo ready"/per-attribute selections are a real, active filter even
    // with no faceClusterFilter (no person picked) — the icon must reflect
    // that the same way it does for every other active filter.
    await waitFor(() => {
      expect(faceFilterButton).toHaveAttribute("aria-pressed", "true");
    });
    expect(faceFilterButton.className).toContain("btn-primary");
  });

  it("shows a named person in the People face panel", async () => {
    fetchPeopleClustersMock.mockResolvedValue({
      clusters: [
        {
          id: "person-4",
          count: 11,
          name: "Scott",
          representative: {
            photo: { path: "trip/b.jpg", name: "b.jpg" },
            box: { x: 0.5, y: 0.5, width: 0.2, height: 0.2 },
          },
        },
      ],
      totalFaces: 11,
      totalClusters: 1,
      pendingFaces: 0,
    });

    renderFilter();

    fireEvent.click(screen.getByRole("button", { name: "People face filter" }));

    expect(await screen.findByRole("button", { name: "Scott, 11 faces" })).toBeInTheDocument();
    expect(screen.getByText("Scott")).toBeInTheDocument();
    expect(screen.getByText("11 faces")).toBeInTheDocument();
  });

  it("shows rating counts and applies selected rating", async () => {
    const localizedTwelveThousand = new Intl.NumberFormat().format(12000);
    fetchSuggestionsWithCountsMock.mockImplementation(({ field }: { field: string }) => {
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
    });

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
    // Click the folder name; the count now lives in its own nested <span>
    // (see above), and the click still bubbles up to the folderCard.
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

    const mediaTypeButton = screen.getByRole("button", { name: "Media type filter" });
    fireEvent.click(mediaTypeButton);
    fireEvent.click(mediaTypeButton);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Media type filter" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
  });

  it("clamps popout to viewport on medium screens", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 800,
    });

    renderFilter();

    fireEvent.click(screen.getByRole("button", { name: "Folders filter" }));

    const panelTitle = await screen.findByText("Folders");
    const panel = panelTitle.closest(".popover-surface");

    expect(panel).not.toBeNull();
    expect(panel).toHaveStyle({
      position: "fixed",
      left: "12px",
      width: "440px",
    });
  });

  it("switches popout to full-width layout on narrow screens", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 560,
    });

    renderFilter();

    fireEvent.click(screen.getByRole("button", { name: "Folders filter" }));

    const panelTitle = await screen.findByText("Folders");
    const panel = panelTitle.closest(".popover-surface");

    expect(panel).not.toBeNull();
    expect(panel).toHaveStyle({
      position: "fixed",
      left: "12px",
      right: "12px",
      width: "auto",
      maxWidth: "none",
    });
  });
});
