import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import App from "./App";

// The whole point of feedback #99: the previous feedback entry point (a
// Ctrl/Cmd+P keyboard shortcut) was explicitly disabled in shared view, so a
// shared-link visitor had no way at all to leave feedback. This file forces
// shared-view mode from module load (isSharedView is read once into a
// module-level constant in App.tsx) to verify the new global "Comments"
// button works there too.
vi.mock("./hooks/useShareFilter", () => ({
  isSharedView: () => true,
  buildShareUrl: (token: string) => `http://localhost/share?token=${token}`,
}));

vi.mock("./auth", () => ({
  extractUrlToken: vi.fn(),
  getAuthHeaders: vi.fn(() => ({})),
  hasAccountSession: vi.fn(() => false),
  initAuth: vi.fn(() => Promise.resolve(true)),
  onUnauthorized: vi.fn(),
}));

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
  useSyncUrlWithFilter: vi.fn(),
}));

vi.mock("./components/selection/SelectionContext", () => ({
  SelectionProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("./components/ViewToggle", () => ({
  ViewToggle: () => <div role="tablist" aria-label="Current view" />,
}));

vi.mock("./components/ThumbnailGrid", () => ({
  ThumbnailGrid: () => <div data-testid="thumbnail-grid">grid</div>,
}));

vi.mock("./components/PeopleView", () => ({
  PeopleView: () => <div data-testid="people-view">people</div>,
}));

vi.mock("./components/FullscreenViewer", () => ({
  FullscreenViewer: () => <div data-testid="fullscreen-viewer">viewer</div>,
}));

vi.mock("./components/StatusModal", () => ({
  StatusModal: () => <div data-testid="status-modal">status</div>,
}));

vi.mock("./components/SuggestionModal", () => ({
  SuggestionModal: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="suggestion-modal">
      <button type="button" onClick={onClose}>
        close suggestion modal
      </button>
    </div>
  ),
}));

vi.mock("./videoPlaybackProfile", () => ({
  probeVideoPlaybackProfile: vi.fn().mockResolvedValue({
    bandwidthMbps: 20,
    hevcSupported: true,
  }),
}));

describe("App in shared view", () => {
  it("still offers the global Comments entry point, and opens the modal", async () => {
    await act(async () => {
      render(<App />);
    });

    // The account/status entry points are gone in shared view (unaffected by
    // this change) — but Comments must still be there.
    expect(screen.queryByRole("button", { name: "Account" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Status" })).not.toBeInTheDocument();

    const commentsButton = screen.getByRole("button", { name: "Comments" });
    expect(screen.queryByTestId("suggestion-modal")).not.toBeInTheDocument();

    fireEvent.click(commentsButton);
    expect(screen.getByTestId("suggestion-modal")).toBeInTheDocument();
  });
});
