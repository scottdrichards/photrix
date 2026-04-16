import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import App from "./App";

const useSelectionContextMock = vi.fn();
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

vi.mock("./components/selection/SelectionContext", () => ({
  SelectionProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useSelectionContext: () => useSelectionContextMock(),
}));

vi.mock("./components/ThumbnailGrid", () => ({
  ThumbnailGrid: () => <div data-testid="thumbnail-grid">grid</div>,
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
    useSelectionContextMock.mockReset();
    probeVideoPlaybackProfileMock.mockClear();
  });

  it("calls url sync hook and enters selection mode from Select button", () => {
    const clearSelection = vi.fn();
    const setSelectionMode = vi.fn();
    useSelectionContextMock.mockReturnValue({
      clearSelection,
      selectedItems: [],
      selectionMode: false,
      setSelectionMode,
    });

    render(<App />);

    expect(probeVideoPlaybackProfileMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Select" }));

    expect(setSelectionMode).toHaveBeenCalledWith(true);
    expect(clearSelection).toHaveBeenCalledTimes(1);
  });

  it("opens status modal from Status button", () => {
    useSelectionContextMock.mockReturnValue({
      clearSelection: vi.fn(),
      selectedItems: [],
      selectionMode: false,
      setSelectionMode: vi.fn(),
    });

    render(<App />);

    expect(screen.getByTestId("status-modal")).toHaveTextContent("closed");
    fireEvent.click(screen.getByRole("button", { name: "Status" }));
    expect(screen.getByTestId("status-modal")).toHaveTextContent("open");
  });

  it("exits selection mode from Done button", () => {
    const clearSelection = vi.fn();
    const setSelectionMode = vi.fn();
    useSelectionContextMock.mockReturnValue({
      clearSelection,
      selectedItems: [{ path: "a/1.jpg" }],
      selectionMode: true,
      setSelectionMode,
    });

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(setSelectionMode).toHaveBeenCalledWith(false);
    expect(clearSelection).toHaveBeenCalledTimes(1);
  });

  it("shares selected items when native share is supported", async () => {
    const clearSelection = vi.fn();
    const setSelectionMode = vi.fn();
    const shareMock = vi.fn().mockResolvedValue(undefined);
    const canShareMock = vi.fn().mockReturnValue(true);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      blob: async () => new Blob(["x"], { type: "image/jpeg" }),
    } as Response);

    Object.defineProperty(window.navigator, "share", {
      value: shareMock,
      configurable: true,
    });
    Object.defineProperty(window.navigator, "canShare", {
      value: canShareMock,
      configurable: true,
    });

    useSelectionContextMock.mockReturnValue({
      clearSelection,
      selectedItems: [
        {
          originalUrl: "http://localhost/a/1.jpg",
          name: "1.jpg",
          metadata: { mimeType: "image/jpeg" },
        },
      ],
      selectionMode: true,
      setSelectionMode,
    });

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Share" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("http://localhost/a/1.jpg");
      expect(canShareMock).toHaveBeenCalled();
      expect(shareMock).toHaveBeenCalled();
    });

    fetchMock.mockRestore();
  });
});
