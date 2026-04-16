import { useEffect, useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FilterProvider, useFilterContext } from "../components/filter/FilterContext";
import { useSyncUrlWithFilter, type ViewMode } from "./useSyncUrlWithFilter";

const SyncHarness = ({ initialView = "library" as ViewMode } = {}) => {
  const [view, setView] = useState<ViewMode>(initialView);
  useSyncUrlWithFilter(view, setView);
  const { filter, setFilter } = useFilterContext();

  useEffect(() => {
    setFilter({ includeSubfolders: true, path: "" });
  }, [setFilter]);

  return (
    <>
      <button
        type="button"
        onClick={() =>
          setFilter({
            includeSubfolders: false,
            path: "photos/2024/",
          })
        }
      >
        set-filter
      </button>
      <div data-testid="path">{filter.path ?? ""}</div>
      <div data-testid="include">{String(filter.includeSubfolders ?? true)}</div>
      <div data-testid="view">{view}</div>
    </>
  );
};

describe("useSyncUrlWithFilter", () => {
  beforeEach(() => {
    window.history.pushState(null, "", "/");
  });

  it("syncs browser URL when filter path and includeSubfolders change", async () => {
    render(
      <FilterProvider>
        <SyncHarness />
      </FilterProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "set-filter" }));

    await waitFor(() => {
      expect(window.location.pathname).toBe("/photos/2024");
      expect(window.location.search).toBe("?includeSubfolders=false");
    });
  });

  it("syncs filter state when browser popstate fires", async () => {
    render(
      <FilterProvider>
        <SyncHarness />
      </FilterProvider>,
    );

    window.history.pushState(null, "", "/travel/italy?includeSubfolders=false");
    fireEvent.popState(window);

    await waitFor(() => {
      expect(screen.getByTestId("path")).toHaveTextContent("travel/italy/");
      expect(screen.getByTestId("include")).toHaveTextContent("false");
    });
  });
});
