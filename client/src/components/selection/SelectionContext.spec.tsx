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
  const {
    selected,
    selectedPaths,
    selectedItems,
    selectionMode,
    setSelectionMode,
    setItems,
    setSelected,
    toggleSelected,
    clearSelection,
    selectNext,
    selectPrevious,
  } = useSelectionContext();

  return (
    <>
      <div data-testid="selected-paths">{selectedPaths.join(",")}</div>
      <div data-testid="selected-name">{selected?.name ?? "none"}</div>
      <div data-testid="selected-count">{selectedItems.length}</div>
      <div data-testid="selection-mode">{String(selectionMode)}</div>
      <button type="button" onClick={() => setItems(photos)}>
        load-items
      </button>
      <button type="button" onClick={() => setItems([photos[0]])}>
        shrink-items
      </button>
      <button type="button" onClick={() => setSelected(photos[0])}>
        set-single
      </button>
      <button type="button" onClick={() => toggleSelected(photos[1])}>
        toggle-second
      </button>
      <button type="button" onClick={selectNext}>
        next
      </button>
      <button type="button" onClick={selectPrevious}>
        previous
      </button>
      <button type="button" onClick={clearSelection}>
        clear
      </button>
      <button type="button" onClick={() => setSelectionMode(true)}>
        mode-on
      </button>
    </>
  );
};

describe("SelectionContext", () => {
  it("supports selecting, toggling, navigation, pruning, and mode changes", () => {
    render(
      <SelectionProvider>
        <SelectionHarness />
      </SelectionProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "load-items" }));
    fireEvent.click(screen.getByRole("button", { name: "set-single" }));

    expect(screen.getByTestId("selected-paths")).toHaveTextContent("a/1.jpg");
    expect(screen.getByTestId("selected-name")).toHaveTextContent("1.jpg");
    expect(screen.getByTestId("selected-count")).toHaveTextContent("1");

    fireEvent.click(screen.getByRole("button", { name: "next" }));
    expect(screen.getByTestId("selected-paths")).toHaveTextContent("a/2.jpg");

    fireEvent.click(screen.getByRole("button", { name: "previous" }));
    expect(screen.getByTestId("selected-paths")).toHaveTextContent("a/1.jpg");

    fireEvent.click(screen.getByRole("button", { name: "toggle-second" }));
    expect(screen.getByTestId("selected-paths")).toHaveTextContent("a/1.jpg,a/2.jpg");
    expect(screen.getByTestId("selected-name")).toHaveTextContent("none");
    expect(screen.getByTestId("selected-count")).toHaveTextContent("2");

    fireEvent.click(screen.getByRole("button", { name: "shrink-items" }));
    expect(screen.getByTestId("selected-paths")).toHaveTextContent("a/1.jpg");
    expect(screen.getByTestId("selected-count")).toHaveTextContent("1");

    fireEvent.click(screen.getByRole("button", { name: "mode-on" }));
    expect(screen.getByTestId("selection-mode")).toHaveTextContent("true");

    fireEvent.click(screen.getByRole("button", { name: "clear" }));
    expect(screen.getByTestId("selected-paths")).toHaveTextContent("");
    expect(screen.getByTestId("selected-count")).toHaveTextContent("0");
  });
});
