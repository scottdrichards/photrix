import { render, screen } from "@testing-library/react";
import { LazyFullscreenViewer } from "./LazyFullscreenViewer";

const selection: { selected: { path: string } | null } = { selected: null };

vi.mock("../selection/SelectionContext", () => ({
  useSelectionContext: () => selection,
}));

vi.mock("./FullscreenViewer", () => ({
  FullscreenViewer: () => <div data-testid="fullscreen-viewer">viewer</div>,
}));

describe("LazyFullscreenViewer", () => {
  it("mounts the viewer with the first photo opened and keeps it mounted", async () => {
    selection.selected = null;
    const { rerender } = render(<LazyFullscreenViewer />);
    expect(screen.queryByTestId("fullscreen-viewer")).not.toBeInTheDocument();

    selection.selected = { path: "/a.jpg" };
    rerender(<LazyFullscreenViewer />);
    expect(await screen.findByTestId("fullscreen-viewer")).toBeInTheDocument();

    // Closing the photo leaves the viewer in place: it keeps state between photos.
    selection.selected = null;
    rerender(<LazyFullscreenViewer />);
    expect(screen.getByTestId("fullscreen-viewer")).toBeInTheDocument();
  });
});
