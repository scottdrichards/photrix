import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { AccountPanel } from "./AccountPanel";
import { initInstall, resetInstallStateForTests } from "../install";

const mocks = vi.hoisted(() => ({
  fetchAccount: vi.fn(),
  fetchMcpKeys: vi.fn(),
  fetchPasskeys: vi.fn(),
  fetchShareLinks: vi.fn(),
  fetchSessions: vi.fn(),
  createMcpKey: vi.fn(),
  revokeMcpKey: vi.fn(),
  removePasskey: vi.fn(),
  revokeShareLink: vi.fn(),
  revokeSession: vi.fn(),
  revokeAllSessions: vi.fn(),
  revokeOtherSessions: vi.fn(),
}));

vi.mock("../api/account", () => mocks);

vi.mock("../auth", () => ({
  isPasskeyAvailable: () => Promise.resolve(false),
  registerPasskey: vi.fn(),
  clearToken: vi.fn(),
}));

vi.mock("../hooks/useShareFilter", () => ({
  buildShareUrl: (token: string) => `https://photrix.test/?token=${token}`,
}));

const resetMocks = () => {
  mocks.fetchAccount.mockResolvedValue({ username: "alice", passkeysAvailable: false });
  mocks.fetchMcpKeys.mockResolvedValue([
    { id: "abc123", name: "Claude", createdAt: 1_700_000_000_000, lastUsedAt: null },
  ]);
  mocks.fetchPasskeys.mockResolvedValue([]);
  mocks.fetchShareLinks.mockResolvedValue([
    {
      token: "photrix-share-v1.tok",
      label: "Beach trip",
      createdAt: 1_700_000_000_000,
      revokedAt: null,
    },
  ]);
  mocks.fetchSessions.mockResolvedValue([
    {
      id: "sess1",
      createdAt: 1_700_000_000_000,
      lastSeenAt: 1_700_000_000_000,
      current: true,
      ip: "203.0.113.5",
      location: "Internet",
    },
  ]);
  mocks.createMcpKey.mockResolvedValue({
    token: "photrix-mcp-v1.newsecret",
    id: "new1",
    name: "Desktop",
    createdAt: 1_700_000_100_000,
  });
  mocks.revokeMcpKey.mockResolvedValue({ ok: true });
};

describe("AccountPanel", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    resetMocks();
  });

  it("loads and renders account details when opened", async () => {
    render(<AccountPanel isOpen={true} onDismiss={vi.fn()} />);

    expect(await screen.findByText("Signed in as alice")).toBeInTheDocument();
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.getByText("Beach trip")).toBeInTheDocument();
    expect(mocks.fetchMcpKeys).toHaveBeenCalled();
  });

  it("reveals a newly generated MCP key exactly once", async () => {
    render(<AccountPanel isOpen={true} onDismiss={vi.fn()} />);
    await screen.findByText("Signed in as alice");

    fireEvent.change(
      screen.getByPlaceholderText("Key name (e.g. Claude Desktop)"),
      { target: { value: "Desktop" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));

    expect(await screen.findByText("photrix-mcp-v1.newsecret")).toBeInTheDocument();
    expect(mocks.createMcpKey).toHaveBeenCalledWith("Desktop");
  });

  it("revokes an MCP key", async () => {
    render(<AccountPanel isOpen={true} onDismiss={vi.fn()} />);
    await screen.findByText("Signed in as alice");

    fireEvent.click(screen.getAllByRole("button", { name: "Revoke" })[0]);

    await waitFor(() => expect(mocks.revokeMcpKey).toHaveBeenCalledWith("abc123"));
  });

  it("closes when clicking the dialog backdrop, not when clicking inside it", async () => {
    const onDismiss = vi.fn();
    render(<AccountPanel isOpen={true} onDismiss={onDismiss} />);
    await screen.findByText("Signed in as alice");

    // A click on a child of the dialog (its content) must not close it.
    fireEvent.click(screen.getByText("Signed in as alice"));
    expect(onDismiss).not.toHaveBeenCalled();

    // A click that lands on the <dialog> element itself (the
    // backdrop/padding area, since content lives in a nested wrapper) closes
    // it, same as clicking "Done".
    fireEvent.click(screen.getByRole("dialog"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("still closes via the explicit Done button", async () => {
    const onDismiss = vi.fn();
    render(<AccountPanel isOpen={true} onDismiss={onDismiss} />);
    await screen.findByText("Signed in as alice");

    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  describe("install app section", () => {
    beforeEach(() => {
      resetInstallStateForTests();
      initInstall();
    });

    it("points at the browser menu when there is no install prompt", async () => {
      render(<AccountPanel isOpen={true} onDismiss={vi.fn()} />);
      await screen.findByText("Signed in as alice");

      expect(screen.getByRole("heading", { name: "Install app" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Install Photrix" })).not.toBeInTheDocument();
    });

    it("offers an Install button once the browser provides a prompt", async () => {
      render(<AccountPanel isOpen={true} onDismiss={vi.fn()} />);
      await screen.findByText("Signed in as alice");

      const prompt = vi.fn().mockResolvedValue(undefined);
      act(() => {
        const event = Object.assign(new Event("beforeinstallprompt"), {
          prompt,
          userChoice: Promise.resolve({ outcome: "accepted" }),
        });
        window.dispatchEvent(event);
      });

      fireEvent.click(await screen.findByRole("button", { name: "Install Photrix" }));
      await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    });

    it("disappears once installed", async () => {
      render(<AccountPanel isOpen={true} onDismiss={vi.fn()} />);
      await screen.findByText("Signed in as alice");

      act(() => {
        window.dispatchEvent(new Event("appinstalled"));
      });

      expect(screen.queryByRole("heading", { name: "Install app" })).not.toBeInTheDocument();
    });
  });
});
