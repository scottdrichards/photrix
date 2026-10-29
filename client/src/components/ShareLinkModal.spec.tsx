import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ShareLinkModal } from "./ShareLinkModal";

const URL_TO_SHARE = "https://example.test/?token=abc";

describe("ShareLinkModal (feedback #156)", () => {
  const originalShare = navigator.share;
  const originalClipboard = navigator.clipboard;

  afterEach(() => {
    Object.defineProperty(navigator, "share", { configurable: true, value: originalShare });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: originalClipboard });
  });

  it("opens the system share sheet with the link when the platform has one", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { configurable: true, value: share });

    render(<ShareLinkModal url={URL_TO_SHARE} copied={false} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Share…" }));

    await waitFor(() => expect(share).toHaveBeenCalledWith(expect.objectContaining({ url: URL_TO_SHARE })));
  });

  it("hides the share button where there is no share sheet", () => {
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined });

    render(<ShareLinkModal url={URL_TO_SHARE} copied={false} onClose={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Share…" })).not.toBeInTheDocument();
  });

  it("copies the link from a fresh tap when the first copy did not happen", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    render(<ShareLinkModal url={URL_TO_SHARE} copied={false} onClose={vi.fn()} />);
    expect(screen.queryByText("Copied to clipboard")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));

    expect(await screen.findByText("Copied to clipboard")).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(URL_TO_SHARE);
  });
});
