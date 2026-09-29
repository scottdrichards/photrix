import { fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import type { PhotoItem } from "../api";
import { SelectionActionBar } from "./SelectionActionBar";
import { SelectionProvider, useSelectionContext } from "./selection/SelectionContext";

const createPhoto = (overrides: Partial<PhotoItem> = {}): PhotoItem => ({
  path: "a/1.jpg",
  name: "1.jpg",
  mediaType: "photo",
  originalUrl: "http://localhost/a/1.jpg",
  thumbnailUrl: "http://localhost/a/1.jpg",
  previewUrl: "http://localhost/a/1.jpg",
  fullUrl: "http://localhost/a/1.jpg",
  ...overrides,
});

const SelectionModeActivator = () => {
  const { enterSelectionMode } = useSelectionContext();

  useEffect(() => {
    enterSelectionMode();
  }, [enterSelectionMode]);

  return null;
};

const SelectionModeWithCheckedItem = () => {
  const { enterSelectionMode, setItems, toggleChecked } = useSelectionContext();

  useEffect(() => {
    const photo = createPhoto();
    setItems([photo]);
    enterSelectionMode();
    toggleChecked(photo);
  }, [enterSelectionMode, setItems, toggleChecked]);

  return null;
};

const renderSelectionMode = () =>
  render(
    <SelectionProvider>
      <SelectionModeActivator />
      <SelectionActionBar />
    </SelectionProvider>,
  );

const renderSelectionModeWithCheckedItem = () =>
  render(
    <SelectionProvider>
      <SelectionModeWithCheckedItem />
      <SelectionActionBar />
    </SelectionProvider>,
  );

describe("SelectionActionBar", () => {
  it("renders nothing outside selection mode, or with nothing checked", () => {
    render(
      <SelectionProvider>
        <SelectionActionBar />
      </SelectionProvider>,
    );

    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();

    const { container } = renderSelectionMode();
    // Selection mode is on, but nothing is checked yet.
    expect(container.querySelector('[role="toolbar"]')).not.toBeInTheDocument();
  });

  // Feedback #142: Share/Download used to live in a second, independent
  // floating bar (ViewToggle's own selection pill) with its own "N selected"
  // count and exit action, duplicating this bar's. They're both here now.
  it("shows share and download actions once something is checked", () => {
    renderSelectionModeWithCheckedItem();

    expect(screen.getByText("1 selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /share/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /download/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /exit selection/i })).toBeInTheDocument();
  });

  it("opens the download quality dialog from this bar", () => {
    renderSelectionModeWithCheckedItem();

    fireEvent.click(screen.getByRole("button", { name: /download/i }));

    expect(screen.getByRole("heading", { name: "Download 1 item" })).toBeInTheDocument();
  });
});
