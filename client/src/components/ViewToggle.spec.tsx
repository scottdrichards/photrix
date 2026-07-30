import { fireEvent, render, screen } from "@testing-library/react";
import { ViewToggle } from "./ViewToggle";
import { SelectionProvider } from "./selection/SelectionContext";

const setScrollY = (value: number) => {
  Object.defineProperty(window, "scrollY", {
    configurable: true,
    writable: true,
    value,
  });
};

const renderViewToggle = (view: "library" | "people" = "library") =>
  render(
    <SelectionProvider>
      <ViewToggle view={view} onViewChange={() => {}} />
    </SelectionProvider>,
  );

describe("ViewToggle", () => {
  beforeEach(() => {
    setScrollY(0);
  });

  it("renders visible (not hidden) at the top of the page", () => {
    renderViewToggle();

    const tablist = screen.getByRole("tablist", { name: "Current view" });
    expect(tablist.parentElement).toHaveAttribute("aria-hidden", "false");
  });

  it("hides completely (no layout/hit-test footprint) when scrolling down", () => {
    renderViewToggle();

    setScrollY(50);
    fireEvent.scroll(window);
    setScrollY(150);
    fireEvent.scroll(window);

    const tablist = screen.getByRole("tablist", { name: "Current view", hidden: true });
    const wrapper = tablist.parentElement;
    expect(wrapper).toHaveAttribute("aria-hidden", "true");
    // Buttons should drop out of the tab order while hidden.
    for (const tab of screen.getAllByRole("tab", { hidden: true })) {
      expect(tab).toHaveAttribute("tabindex", "-1");
    }
  });

  it("reappears anchored under the header when scrolling back up", () => {
    renderViewToggle();

    // Scroll down first so the pill is hidden and scrolled away from the top.
    setScrollY(50);
    fireEvent.scroll(window);
    setScrollY(400);
    fireEvent.scroll(window);

    // Now scroll back up.
    setScrollY(350);
    fireEvent.scroll(window);

    const tablist = screen.getByRole("tablist", { name: "Current view" });
    const wrapper = tablist.parentElement as HTMLElement;
    expect(wrapper).toHaveAttribute("aria-hidden", "false");
    expect(wrapper.style.top).toBe("12px"); // no <header> in test DOM, so headerHeight is 0
  });

  it("returns to the top anchor and reveals itself once scrolled back near the top", () => {
    renderViewToggle();

    setScrollY(50);
    fireEvent.scroll(window);
    setScrollY(150);
    fireEvent.scroll(window);

    setScrollY(10);
    fireEvent.scroll(window);

    const tablist = screen.getByRole("tablist", { name: "Current view" });
    expect(tablist.parentElement).toHaveAttribute("aria-hidden", "false");
  });
});
