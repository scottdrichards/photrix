import { render, screen } from "@testing-library/react";
import { SortDockPortal, SortDockProvider } from "./SortDockPortal";

describe("SortDockPortal", () => {
  it("renders children into the provided host", () => {
    const host = document.createElement("div");
    host.setAttribute("data-testid", "sort-dock-host");
    document.body.appendChild(host);

    render(
      <SortDockProvider host={host}>
        <SortDockPortal>
          <button type="button">Portal child</button>
        </SortDockPortal>
      </SortDockProvider>,
    );

    expect(screen.getByTestId("sort-dock-host")).toContainElement(
      screen.getByRole("button", { name: "Portal child" }),
    );

    host.remove();
  });

  it("renders nothing when no host is available", () => {
    const { container } = render(
      <SortDockProvider host={null}>
        <SortDockPortal>
          <button type="button">Portal child</button>
        </SortDockPortal>
      </SortDockProvider>,
    );

    expect(screen.queryByRole("button", { name: "Portal child" })).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });
});
