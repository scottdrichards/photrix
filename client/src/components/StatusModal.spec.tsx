import { act, fireEvent, render, screen } from "@testing-library/react";
import { StatusModal } from "./StatusModal";

const subscribeStatusStreamMock = vi.fn();
const setBackgroundTasksEnabledMock = vi.fn();

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    subscribeStatusStream: (...args: unknown[]) => subscribeStatusStreamMock(...args),
    setBackgroundTasksEnabled: (...args: unknown[]) =>
      setBackgroundTasksEnabledMock(...args),
  };
});

const makeStatus = (overrides?: Record<string, unknown>) => ({
  files: { total: 10, images: 7, videos: 1 },
  pending: { fileMetadata: 2, mediaMetadata: 5, thumbnails: 3 },
  maintenance: { backgroundTasksEnabled: true },
  ...overrides,
});

describe("StatusModal", () => {
  beforeEach(() => {
    subscribeStatusStreamMock.mockReset();
    setBackgroundTasksEnabledMock.mockReset();
  });

  it("subscribes and renders streamed status data", async () => {
    const unsubscribe = vi.fn();
    let onUpdate: ((status: unknown) => void) | undefined;

    subscribeStatusStreamMock.mockImplementation((update) => {
      onUpdate = update as (status: unknown) => void;
      return unsubscribe;
    });

    render(<StatusModal isOpen={true} onDismiss={vi.fn()} />);

    expect(subscribeStatusStreamMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      onUpdate?.(makeStatus());
    });

    expect(await screen.findByText(/Files:/)).toBeInTheDocument();
    expect(screen.getByText("10")).toBeInTheDocument();
    expect(screen.getByText(/File metadata to scan:/)).toBeInTheDocument();
    expect(screen.getByText(/Media metadata to scan:/)).toBeInTheDocument();
    expect(screen.getByText(/Thumbnails to process:/)).toBeInTheDocument();
  });

  it("calls onDismiss when Close is clicked", () => {
    subscribeStatusStreamMock.mockReturnValue(() => undefined);
    const onDismiss = vi.fn();

    render(<StatusModal isOpen={true} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("toggles background tasks from the status modal", async () => {
    const unsubscribe = vi.fn();
    let onUpdate: ((status: unknown) => void) | undefined;

    subscribeStatusStreamMock.mockImplementation((update) => {
      onUpdate = update as (status: unknown) => void;
      return unsubscribe;
    });
    setBackgroundTasksEnabledMock.mockResolvedValue({ enabled: false });

    render(<StatusModal isOpen={true} onDismiss={vi.fn()} />);

    await act(async () => {
      onUpdate?.(makeStatus({ maintenance: { backgroundTasksEnabled: true } }));
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: "Enable background tasks" }));
    });

    expect(setBackgroundTasksEnabledMock).toHaveBeenCalledWith(false);
  });

  it("shows loading indicator before first status update", () => {
    subscribeStatusStreamMock.mockReturnValue(() => undefined);

    render(<StatusModal isOpen={true} onDismiss={vi.fn()} />);

    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });

  it("renders as a modal dialog", () => {
    subscribeStatusStreamMock.mockReturnValue(() => undefined);

    render(<StatusModal isOpen={true} onDismiss={vi.fn()} />);

    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
  });

  it("updates stats on successive status events", async () => {
    const unsubscribe = vi.fn();
    let onUpdate: ((status: unknown) => void) | undefined;

    subscribeStatusStreamMock.mockImplementation((update) => {
      onUpdate = update as (status: unknown) => void;
      return unsubscribe;
    });

    render(<StatusModal isOpen={true} onDismiss={vi.fn()} />);

    await act(async () => {
      onUpdate?.(makeStatus({ pending: { fileMetadata: 2, mediaMetadata: 5, thumbnails: 5 } }));
      onUpdate?.(makeStatus({ pending: { fileMetadata: 2, mediaMetadata: 5, thumbnails: 42 } }));
    });

    expect(await screen.findByText(/Thumbnails to process:/)).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("unsubscribes on unmount", () => {
    const unsubscribe = vi.fn();
    subscribeStatusStreamMock.mockReturnValue(unsubscribe);

    const { unmount } = render(<StatusModal isOpen={true} onDismiss={vi.fn()} />);

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

