import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import App from "./App";

vi.mock("./auth", () => ({
  extractUrlToken: vi.fn(),
  getAuthHeaders: vi.fn(() => ({})),
  hasAccountSession: vi.fn(() => false),
  initAuth: vi.fn(() => Promise.resolve(true)),
  onUnauthorized: vi.fn(),
}));

const useSyncUrlWithFilterMock = vi.fn();
const probeVideoPlaybackProfileMock = vi.fn().mockResolvedValue({
  bandwidthMbps: 20,
  hevcSupported: true,
});

vi.mock("./components/SearchBar", () => ({
  SearchBar: () => <div data-testid="search-bar">search</div>,
}));

vi.mock("./components/filter/Filter", () => ({
  Filter: () => <div data-testid="filter">filter</div>,
}));

vi.mock("./components/filter/FilterContext", () => ({
  FilterProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useFilter: vi.fn(() => ({ filter: {} })),
}));

vi.mock("./hooks/useSyncUrlWithFilter", () => ({
  useSyncUrlWithFilter: (...args: unknown[]) => useSyncUrlWithFilterMock(...args),
}));

vi.mock("./components/selection/SelectionContext", () => ({
  SelectionProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("./components/ViewToggle", () => ({
  ViewToggle: ({
    view,
    onViewChange,
  }: {
    view: string;
    onViewChange: (v: string) => void;
  }) => (
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
  ThumbnailGrid: ({
    view,
    onViewChange,
  }: {
    view: string;
    onViewChange: (v: string) => void;
  }) => (
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
  PeopleView: ({
    view,
    onViewChange,
  }: {
    view: string;
    onViewChange: (v: string) => void;
  }) => (
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
  let systemDarkMode = false;
  const mediaQueryListeners = new Set<(event: MediaQueryListEvent) => void>();

  const setSystemDarkMode = (nextValue: boolean) => {
    systemDarkMode = nextValue;
    const event = { matches: nextValue } as MediaQueryListEvent;
    mediaQueryListeners.forEach((listener) => listener(event));
  };

  beforeAll(() => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        get matches() {
          return systemDarkMode;
        },
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn((event: string, listener: (event: MediaQueryListEvent) => void) => {
          if (event === "change") mediaQueryListeners.add(listener);
        }),
        removeEventListener: vi.fn(
          (event: string, listener: (event: MediaQueryListEvent) => void) => {
            if (event === "change") mediaQueryListeners.delete(listener);
          },
        ),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  beforeEach(() => {
    systemDarkMode = false;
    mediaQueryListeners.clear();
    useSyncUrlWithFilterMock.mockReset();
    probeVideoPlaybackProfileMock.mockClear();
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("calls url sync hook", async () => {
    await act(async () => {
      render(<App />);
    });

    expect(probeVideoPlaybackProfileMock).toHaveBeenCalledTimes(1);
    expect(useSyncUrlWithFilterMock).toHaveBeenCalledWith(
      expect.objectContaining({
        view: "library",
        people: { personId: null, groupId: null },
      }),
      expect.any(Function),
    );
  });

  it("opens status modal from Status button", async () => {
    await act(async () => {
      render(<App />);
    });

    expect(screen.getByTestId("status-modal")).toHaveTextContent("closed");
    fireEvent.click(screen.getByRole("button", { name: "Status" }));
    expect(screen.getByTestId("status-modal")).toHaveTextContent("open");
  });

  it("switches between thumbnail and people views", async () => {
    await act(async () => {
      render(<App />);
    });

    expect(screen.getByTestId("thumbnail-grid")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "People" }));
    expect(screen.getByTestId("people-view")).toBeInTheDocument();
  });

  it("follows the system theme by default", async () => {
    setSystemDarkMode(true);

    await act(async () => {
      render(<App />);
    });

    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(screen.getByRole("switch", { name: "Theme" })).toHaveAttribute("aria-checked", "true");
    expect(window.localStorage.getItem("photrix_theme")).toBeNull();
  });

  it("uses a stored dark theme preference", async () => {
    window.localStorage.setItem("photrix_theme", "dark");

    await act(async () => {
      render(<App />);
    });

    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(screen.getByRole("switch", { name: "Theme" })).toHaveAttribute("aria-checked", "true");
  });

  it("toggles the theme and only persists an override when needed", async () => {
    await act(async () => {
      render(<App />);
    });

    const toggle = screen.getByRole("switch", { name: "Theme" });
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(window.localStorage.getItem("photrix_theme")).toBeNull();

    fireEvent.click(toggle);

    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(window.localStorage.getItem("photrix_theme")).toBe("dark");

    fireEvent.click(toggle);

    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(window.localStorage.getItem("photrix_theme")).toBeNull();
  });

  it("keeps following system changes until the user overrides the theme", async () => {
    await act(async () => {
      render(<App />);
    });

    await act(async () => {
      setSystemDarkMode(true);
    });

    const toggle = screen.getByRole("switch", { name: "Theme" });
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(toggle).toHaveAttribute("aria-checked", "true");

    fireEvent.click(toggle);

    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(window.localStorage.getItem("photrix_theme")).toBe("light");

    await act(async () => {
      setSystemDarkMode(true);
    });

    expect(document.documentElement).toHaveAttribute("data-theme", "light");
  });
});
