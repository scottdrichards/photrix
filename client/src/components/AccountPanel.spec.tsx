import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AccountPanel } from "./AccountPanel";

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
  mocks.fetchAccount.mockResolvedValue({ username: "alice" });
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
    { id: "sess1", createdAt: 1_700_000_000_000, current: true },
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
});
