import { fireEvent, render, screen } from "@testing-library/react";
import type { PhotoItem } from "../../api";
import { SelectionProvider, useSelectionContext } from "./SelectionContext";

const createPhoto = (path: string): PhotoItem => ({
  path,
  name: path.split("/").pop() ?? path,
  mediaType: "photo",
  originalUrl: `http://localhost/${path}`,
  thumbnailUrl: `http://localhost/${path}`,
  previewUrl: `http://localhost/${path}`,
  fullUrl: `http://localhost/${path}`,
});

const photos = [createPhoto("a/1.jpg"), createPhoto("a/2.jpg"), createPhoto("a/3.jpg")];

const SelectionHarness = () => {
  const { items, selected, setItems, setSelected, selectByPath, selectNext, selectPrevious } =
    useSelectionContext();

  return (
    <>
      <div data-testid="items-count">{items.length}</div>
      <div data-testid="selected-name">{selected?.name ?? "none"}</div>
      <button type="button" onClick={() => setItems(photos)}>
        load-items
      </button>
      <button type="button" onClick={() => setItems([photos[0]])}>
        shrink-items
      </button>
      <button type="button" onClick={() => setSelected(photos[0])}>
        set-first
      </button>
      <button type="button" onClick={() => setSelected(photos[1])}>
        set-second
      </button>
      <button type="button" onClick={() => setSelected(null)}>
        clear-selection
      </button>
      <button type="button" onClick={() => selectByPath("a/2.jpg")}>
        select-by-path-second
      </button>
      <button type="button" onClick={() => selectByPath("does/not/exist.jpg")}>
        select-by-path-missing
      </button>
      <button type="button" onClick={selectNext}>
        next
      </button>
      <button type="button" onClick={selectPrevious}>
        previous
      </button>
    </>
  );
};

describe("SelectionContext", () => {
  it("supports selecting, navigation, and item pruning", () => {
    render(
      <SelectionProvider>
        <SelectionHarness />
      </SelectionProvider>,
    );

    expect(screen.getByTestId("items-count")).toHaveTextContent("0");
    expect(screen.getByTestId("selected-name")).toHaveTextContent("none");

    fireEvent.click(screen.getByRole("button", { name: "load-items" }));
    expect(screen.getByTestId("items-count")).toHaveTextContent("3");

    fireEvent.click(screen.getByRole("button", { name: "set-first" }));
    expect(screen.getByTestId("selected-name")).toHaveTextContent("1.jpg");

    fireEvent.click(screen.getByRole("button", { name: "next" }));
    expect(screen.getByTestId("selected-name")).toHaveTextContent("2.jpg");

    fireEvent.click(screen.getByRole("button", { name: "next" }));
    expect(screen.getByTestId("selected-name")).toHaveTextContent("3.jpg");

    fireEvent.click(screen.getByRole("button", { name: "previous" }));
    expect(screen.getByTestId("selected-name")).toHaveTextContent("2.jpg");

    fireEvent.click(screen.getByRole("button", { name: "shrink-items" }));
    expect(screen.getByTestId("items-count")).toHaveTextContent("1");
    expect(screen.getByTestId("selected-name")).toHaveTextContent("none");

    fireEvent.click(screen.getByRole("button", { name: "set-second" }));
    fireEvent.click(screen.getByRole("button", { name: "clear-selection" }));
    expect(screen.getByTestId("selected-name")).toHaveTextContent("none");
  });

  // Feedback #120: selectByPath is the URL-driven entry point (initial load
  // with ?preview=, browser back/forward) — it has no PhotoItem in hand, only
  // a path, and must resolve gracefully rather than throw when that path
  // isn't (yet, or ever) in the loaded items.
  it("selects by path once matching items are loaded, and no-ops for an unknown path", () => {
    render(
      <SelectionProvider>
        <SelectionHarness />
      </SelectionProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "select-by-path-missing" }));
    expect(screen.getByTestId("selected-name")).toHaveTextContent("none");

    fireEvent.click(screen.getByRole("button", { name: "load-items" }));
    fireEvent.click(screen.getByRole("button", { name: "select-by-path-second" }));
    expect(screen.getByTestId("selected-name")).toHaveTextContent("2.jpg");
  });
});
