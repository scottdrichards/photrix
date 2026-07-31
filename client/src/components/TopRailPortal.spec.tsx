import { render, screen } from "@testing-library/react";
import { TopRailPortal, TopRailPortalProvider } from "./TopRailPortal";

describe("TopRailPortal", () => {
  it("renders children into the provided host", () => {
    const host = document.createElement("div");
    host.setAttribute("data-testid", "top-rail-host");
    document.body.appendChild(host);

    render(
      <TopRailPortalProvider host={host}>
        <TopRailPortal>
          <button type="button">Portal child</button>
        </TopRailPortal>
      </TopRailPortalProvider>,
    );

    expect(screen.getByTestId("top-rail-host")).toContainElement(
      screen.getByRole("button", { name: "Portal child" }),
    );

    host.remove();
  });

  it("renders nothing when no host is available", () => {
    const { container } = render(
      <TopRailPortalProvider host={null}>
        <TopRailPortal>
          <button type="button">Portal child</button>
        </TopRailPortal>
      </TopRailPortalProvider>,
    );

    expect(screen.queryByRole("button", { name: "Portal child" })).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });
});
