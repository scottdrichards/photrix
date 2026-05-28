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
  backgroundTasks: [
    {
      id: "background:file-system-scan",
      name: "File system scan",
      queue: "background",
      state: "running",
      itemsProcessed: 25,
      total: 100,
      portionComplete: 0.25,
      description: "scanning /photos",
    },
  ],
  maintenance: { backgroundTasksEnabled: true },
  ...overrides,
});

describe("StatusModal", () => {
  beforeEach(() => {
    subscribeStatusStreamMock.mockReset();
    setBackgroundTasksEnabledMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
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

    expect(await screen.findByText(/Background tasks/)).toBeInTheDocument();
    expect(screen.getByText("File system scan")).toBeInTheDocument();
    expect(screen.getByText("25%")).toBeInTheDocument();
    expect(screen.getByText(/25 \/ 100 items/)).toBeInTheDocument();
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
      onUpdate?.(
        makeStatus({
          backgroundTasks: [
            {
              id: "background:file-system-scan",
              name: "File system scan",
              queue: "background",
              state: "running",
              itemsProcessed: 42,
              total: 100,
              portionComplete: 0.42,
            },
          ],
        }),
      );
    });

    expect(await screen.findByText(/Background tasks/)).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("renders queued tasks without progress metadata", async () => {
    const unsubscribe = vi.fn();
    let onUpdate: ((status: unknown) => void) | undefined;

    subscribeStatusStreamMock.mockImplementation((update) => {
      onUpdate = update as (status: unknown) => void;
      return unsubscribe;
    });
    render(<StatusModal isOpen={true} onDismiss={vi.fn()} />);

    await act(async () => {
      onUpdate?.(
        makeStatus({
          backgroundTasks: [
            {
              id: "background:face-detection",
              name: "Face detection",
              queue: "background",
              state: "queued",
            },
          ],
        }),
      );
    });

    expect(await screen.findByText("Face detection")).toBeInTheDocument();
    expect(screen.getByText(/State: Queued/)).toBeInTheDocument();
  });

  it("unsubscribes on unmount", () => {
    const unsubscribe = vi.fn();
    subscribeStatusStreamMock.mockReturnValue(unsubscribe);

    const { unmount } = render(<StatusModal isOpen={true} onDismiss={vi.fn()} />);

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

