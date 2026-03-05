import { fireEvent, render, screen } from "@testing-library/react";
import { FilterProvider, useFilterContext } from "./FilterContext";

const FilterContextHarness = () => {
  const { filter, setFilter } = useFilterContext();

  return (
    <>
      <div data-testid="path">{filter.path}</div>
      <div data-testid="include">{String(filter.includeSubfolders)}</div>
      <div data-testid="media">{filter.mediaTypeFilter}</div>
      <button
        type="button"
        onClick={() =>
          setFilter({
            path: "photos/",
            includeSubfolders: false,
            mediaTypeFilter: "video",
          })
        }
      >
        partial-update
      </button>
      <button
        type="button"
        onClick={() =>
          setFilter((previous) => ({
            ...previous,
            path: "photos/2024/",
          }))
        }
      >
        functional-update
      </button>
    </>
  );
};

describe("FilterContext", () => {
  beforeEach(() => {
    window.history.pushState(null, "", "/albums/family?includeSubfolders=false");
  });

  it("initializes from URL state", () => {
    render(
      <FilterProvider>
        <FilterContextHarness />
      </FilterProvider>,
    );

    expect(screen.getByTestId("path")).toHaveTextContent("albums/family/");
    expect(screen.getByTestId("include")).toHaveTextContent("false");
    expect(screen.getByTestId("media")).toHaveTextContent("all");
  });

  it("supports partial and functional updates", () => {
    render(
      <FilterProvider>
        <FilterContextHarness />
      </FilterProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "partial-update" }));
    expect(screen.getByTestId("path")).toHaveTextContent("photos/");
    expect(screen.getByTestId("include")).toHaveTextContent("false");
    expect(screen.getByTestId("media")).toHaveTextContent("video");

    fireEvent.click(screen.getByRole("button", { name: "functional-update" }));
    expect(screen.getByTestId("path")).toHaveTextContent("photos/2024/");
    expect(screen.getByTestId("include")).toHaveTextContent("false");
    expect(screen.getByTestId("media")).toHaveTextContent("video");
  });
});
