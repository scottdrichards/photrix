import { fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import type { PhotoItem } from "../api";
import { ViewToggle } from "./ViewToggle";
import { SelectionProvider, useSelectionContext } from "./selection/SelectionContext";

const renderViewToggle = (view: "library" | "people" = "library") =>
  render(
    <SelectionProvider>
      <ViewToggle view={view} onViewChange={() => {}} />
    </SelectionProvider>,
  );

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

const renderSelectionModeViewToggle = (view: "library" | "people" = "library") =>
  render(
    <SelectionProvider>
      <SelectionModeActivator />
      <ViewToggle view={view} onViewChange={() => {}} />
    </SelectionProvider>,
  );

const renderSelectionModeWithCheckedItem = (view: "library" | "people" = "library") =>
  render(
    <SelectionProvider>
      <SelectionModeWithCheckedItem />
      <ViewToggle view={view} onViewChange={() => {}} />
    </SelectionProvider>,
  );

describe("ViewToggle", () => {
  // Feedback #121/#122/#123: this used to hide on scroll-down and reappear
  // on any scroll-up (not just at the top of the page), so it could pop
  // back over content anywhere in a long grid. It now floats fixed to the
  // bottom of the viewport (see App.module.css's .floatingBarDock) and
  // never hides itself, so there's no scroll-driven visibility left to test.
  it("renders visible and interactive regardless of scroll position", () => {
    renderViewToggle();

    setScrollYForTest(400);
    fireEvent.scroll(window);

    const tablist = screen.getByRole("tablist", { name: "Current view" });
    expect(tablist.parentElement).not.toHaveAttribute("aria-hidden", "true");
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab).not.toHaveAttribute("tabindex", "-1");
    }
  });

  it("shows share and download actions in selection mode", () => {
    renderSelectionModeViewToggle();

    expect(screen.getByRole("button", { name: /share/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /download/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /clear/i })).toBeInTheDocument();
  });

  it("opens the download quality dialog from selection mode", () => {
    renderSelectionModeWithCheckedItem();

    fireEvent.click(screen.getByRole("button", { name: /download/i }));

    expect(screen.getByRole("heading", { name: "Download 1 item" })).toBeInTheDocument();
  });
});

function setScrollYForTest(value: number) {
  Object.defineProperty(window, "scrollY", {
    configurable: true,
    writable: true,
    value,
  });
}
