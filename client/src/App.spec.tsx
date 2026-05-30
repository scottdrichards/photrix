import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import App from "./App";

const useSyncUrlWithFilterMock = vi.fn();
const probeVideoPlaybackProfileMock = vi.fn().mockResolvedValue({
  bandwidthMbps: 20,
  hevcSupported: true,
});

vi.mock("./components/filter/Filter", () => ({
  Filter: () => <div data-testid="filter">filter</div>,
}));

vi.mock("./components/filter/FilterContext", () => ({
  FilterProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("./hooks/useSyncUrlWithFilter", () => ({
  useSyncUrlWithFilter: (...args: unknown[]) => useSyncUrlWithFilterMock(...args),
}));

vi.mock("./components/selection/SelectionContext", () => ({
  SelectionProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("./components/ViewToggle", () => ({
  ViewToggle: ({ view, onViewChange }: { view: string; onViewChange: (v: string) => void }) => (
    <div role="tablist" aria-label="Current view">
      <button
        type="button"
        role="tab"
        aria-selected={view === "library"}
        onClick={() => onViewChange("library")}
      >
        Thumbnails
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={view === "people"}
        onClick={() => onViewChange("people")}
      >
        People
      </button>
    </div>
  ),
}));

vi.mock("./components/ThumbnailGrid", () => ({
  ThumbnailGrid: ({ view, onViewChange }: { view: string; onViewChange: (v: string) => void }) => (
    <div data-testid="thumbnail-grid">
      <div role="tablist" aria-label="Current view">
        <button
          type="button"
          role="tab"
          aria-selected={view === "library"}
          onClick={() => onViewChange("library")}
        >
          Thumbnails
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "people"}
          onClick={() => onViewChange("people")}
        >
          People
        </button>
      </div>
      grid
    </div>
  ),
}));

vi.mock("./components/PeopleView", () => ({
  PeopleView: ({ view, onViewChange }: { view: string; onViewChange: (v: string) => void }) => (
    <div data-testid="people-view">
      <div role="tablist" aria-label="Current view">
        <button
          type="button"
          role="tab"
          aria-selected={view === "library"}
          onClick={() => onViewChange("library")}
        >
          Thumbnails
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "people"}
          onClick={() => onViewChange("people")}
        >
          People
        </button>
      </div>
      people
    </div>
  ),
}));

vi.mock("./components/FullscreenViewer", () => ({
  FullscreenViewer: () => <div data-testid="fullscreen-viewer">viewer</div>,
}));

vi.mock("./components/StatusModal", () => ({
  StatusModal: ({ isOpen }: { isOpen: boolean }) => (
    <div data-testid="status-modal">{isOpen ? "open" : "closed"}</div>
  ),
}));

vi.mock("./videoPlaybackProfile", () => ({
  probeVideoPlaybackProfile: () => probeVideoPlaybackProfileMock(),
}));

describe("App", () => {
  beforeEach(() => {
    useSyncUrlWithFilterMock.mockReset();
    probeVideoPlaybackProfileMock.mockClear();
  });

  it("calls url sync hook", () => {
    render(<App />);

    expect(probeVideoPlaybackProfileMock).toHaveBeenCalledTimes(1);
    expect(useSyncUrlWithFilterMock).toHaveBeenCalledWith(
      "library",
      expect.any(Function),
    );
  });

  it("opens status modal from Status button", () => {
    render(<App />);

    expect(screen.getByTestId("status-modal")).toHaveTextContent("closed");
    fireEvent.click(screen.getByRole("button", { name: "Status" }));
    expect(screen.getByTestId("status-modal")).toHaveTextContent("open");
  });

  it("switches between thumbnail and people views", () => {
    render(<App />);

    expect(screen.getByTestId("thumbnail-grid")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "People" }));
    expect(screen.getByTestId("people-view")).toBeInTheDocument();
  });
});
