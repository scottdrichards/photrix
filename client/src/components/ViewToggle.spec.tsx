import { fireEvent, render, screen } from "@testing-library/react";
import { ViewToggle } from "./ViewToggle";
import { SelectionProvider } from "./selection/SelectionContext";

const renderViewToggle = (view: "library" | "people" = "library") =>
  render(
    <SelectionProvider>
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

  // Feedback #142: this used to swap to its own "N selected / Share /
  // Download / Clear" bar in selection mode -- a second bar duplicating
  // SelectionActionBar's own count and exit action. It now just keeps
  // showing the ordinary view toggle; selection actions live in exactly one
  // place (see SelectionActionBar.spec.tsx).
  it("keeps showing the plain view toggle in selection mode", () => {
    renderViewToggle();

    expect(screen.getByRole("tablist", { name: "Current view" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /share/i })).not.toBeInTheDocument();
  });
});

function setScrollYForTest(value: number) {
  Object.defineProperty(window, "scrollY", {
    configurable: true,
    writable: true,
    value,
  });
}
