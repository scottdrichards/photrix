import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import App from "./App";

const useSelectionContextMock = vi.fn();
const useSyncUrlWithFilterMock = vi.fn();
const useAuthSessionMock = vi.fn();
const probeVideoPlaybackProfileMock = vi.fn().mockResolvedValue({
  bandwidthMbps: 20,
  hevcSupported: true,
});

vi.mock("./components/filter/Filter", () => ({
  Filter: () => <div data-testid="filter">filter</div>,
}));

vi.mock("./auth/AuthGate", () => ({
  AuthGate: ({ children }: { children: ReactNode }) => <>{children}</>,
  useAuthSession: () => useAuthSessionMock(),
}));

vi.mock("./components/filter/FilterContext", () => ({
  FilterProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("./components/selection/SelectionContext", () => ({
  SelectionProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useSelectionContext: () => useSelectionContextMock(),
}));

vi.mock("./hooks/useSyncUrlWithFilter", () => ({
  useSyncUrlWithFilter: () => useSyncUrlWithFilterMock(),
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

vi.mock("./components/faces/FacesReviewPage", () => ({
  FacesReviewPage: () => <div data-testid="faces-review-page">faces</div>,
}));

vi.mock("./videoPlaybackProfile", () => ({
  probeVideoPlaybackProfile: () => probeVideoPlaybackProfileMock(),
}));

describe("App", () => {
  beforeEach(() => {
    useSelectionContextMock.mockReset();
    useSyncUrlWithFilterMock.mockReset();
    useAuthSessionMock.mockReset();
    probeVideoPlaybackProfileMock.mockClear();
    useAuthSessionMock.mockReturnValue({
      username: "scott",
      isSigningOut: false,
      signOut: vi.fn(),
    });
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

    expect(useSyncUrlWithFilterMock).toHaveBeenCalled();
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

  it("opens user menu and signs out from the header", async () => {
    const signOut = vi.fn().mockResolvedValue(undefined);
    useAuthSessionMock.mockReturnValue({
      username: "Scott",
      isSigningOut: false,
      signOut,
    });
    useSelectionContextMock.mockReturnValue({
      clearSelection: vi.fn(),
      selectedItems: [],
      selectionMode: false,
      setSelectionMode: vi.fn(),
    });

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Scott" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }));

    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("switches between library and faces views", () => {
    useSelectionContextMock.mockReturnValue({
      clearSelection: vi.fn(),
      selectedItems: [],
      selectionMode: false,
      setSelectionMode: vi.fn(),
    });

    render(<App />);

    expect(screen.getByTestId("thumbnail-grid")).toBeInTheDocument();
    expect(screen.queryByTestId("faces-review-page")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Faces" }));

    expect(screen.getByTestId("faces-review-page")).toBeInTheDocument();
    expect(screen.queryByTestId("thumbnail-grid")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Library" }));

    expect(screen.getByTestId("thumbnail-grid")).toBeInTheDocument();
  });

  it("initializes faces view when URL has view=faces", () => {
    window.history.pushState(null, "", "/?view=faces");
    useSelectionContextMock.mockReturnValue({
      clearSelection: vi.fn(),
      selectedItems: [],
      selectionMode: false,
      setSelectionMode: vi.fn(),
    });

    render(<App />);

    expect(screen.getByTestId("faces-review-page")).toBeInTheDocument();
    expect(screen.queryByTestId("thumbnail-grid")).not.toBeInTheDocument();

    window.history.pushState(null, "", "/");
  });

  it("shows filter in both library and faces views", () => {
    useSelectionContextMock.mockReturnValue({
      clearSelection: vi.fn(),
      selectedItems: [],
      selectionMode: false,
      setSelectionMode: vi.fn(),
    });

    render(<App />);

    expect(screen.getByTestId("filter")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Faces" }));

    expect(screen.getByTestId("filter")).toBeInTheDocument();
  });
});
