import { act, fireEvent, render, screen } from "@testing-library/react";
import { StatusModal } from "./StatusModal";

const subscribeStatusStreamMock = vi.fn();
const setBackgroundTasksEnabledMock = vi.fn();
const fetchFeedbackItemsMock = vi.fn();

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    subscribeStatusStream: (...args: unknown[]) => subscribeStatusStreamMock(...args),
    setBackgroundTasksEnabled: (...args: unknown[]) =>
      setBackgroundTasksEnabledMock(...args),
    fetchFeedbackItems: (...args: unknown[]) => fetchFeedbackItemsMock(...args),
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
    fetchFeedbackItemsMock.mockReset();
    fetchFeedbackItemsMock.mockResolvedValue([]);
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

    expect((await screen.findAllByText(/Background tasks/)).length).toBeGreaterThan(0);
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

  it("ignores dialog showModal state races", () => {
    subscribeStatusStreamMock.mockReturnValue(() => undefined);
    const showModalSpy = vi
      .spyOn(HTMLDialogElement.prototype, "showModal")
      .mockImplementation(() => {
        throw new DOMException("Already open", "InvalidStateError");
      });

    expect(() => render(<StatusModal isOpen={true} onDismiss={vi.fn()} />)).not.toThrow();

    showModalSpy.mockRestore();
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

    expect((await screen.findAllByText(/Background tasks/)).length).toBeGreaterThan(0);
    expect(screen.getByText("42%")).toBeInTheDocument();
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

  it("renders per-worker VRAM and the GPU-reclaimed state", async () => {
    let onUpdate: ((status: unknown) => void) | undefined;
    subscribeStatusStreamMock.mockImplementation((update) => {
      onUpdate = update as (status: unknown) => void;
      return () => undefined;
    });

    render(<StatusModal isOpen={true} onDismiss={vi.fn()} />);

    await act(async () => {
      onUpdate?.(
        makeStatus({
          system: {
            cpu: { usage: 10, cores: 8 },
            memory: { used: 4_000_000_000, total: 16_000_000_000, usage: 25 },
            gpu: {
              usage: 11,
              memory: { used: 4000, total: 8000 },
              processes: [
                { pid: 111, role: "whisper", vramMB: 3326 },
                { pid: 222, role: "other", vramMB: 500 },
              ],
            },
            workers: [
              {
                id: "whisper-audio",
                role: "whisper",
                pid: 111,
                vramMB: 3326,
                rssMB: 2048,
                suspended: true,
                leases: 0,
              },
            ],
          },
          arbitration: {
            userActive: true,
            workersSuspended: true,
            gpuReclaimed: true,
            overloaded: false,
            runningTasks: [],
          },
        }),
      );
    });

    expect(await screen.findByText("Compute workers / VRAM")).toBeInTheDocument();
    expect(screen.getByText("Transcription (Whisper)")).toBeInTheDocument();
    expect(screen.getByText("Transcode / other")).toBeInTheDocument();
    expect(screen.getByText("GPU reclaimed for playback")).toBeInTheDocument();
    expect(screen.getByText("frozen")).toBeInTheDocument();
  });

  it("still shows the VRAM section when all GPU memory is held outside the container", async () => {
    let onUpdate: ((status: unknown) => void) | undefined;
    subscribeStatusStreamMock.mockImplementation((update) => {
      onUpdate = update as (status: unknown) => void;
      return () => undefined;
    });

    render(<StatusModal isOpen={true} onDismiss={vi.fn()} />);

    await act(async () => {
      onUpdate?.(
        makeStatus({
          system: {
            cpu: { usage: 1, cores: 8 },
            memory: { used: 4_000_000_000, total: 16_000_000_000, usage: 25 },
            // VRAM is used but no compute process is visible inside the LXC, so
            // it all lands in unaccountedMB. The section must not disappear.
            gpu: {
              usage: 1,
              memory: { used: 4699, total: 8188 },
              processes: [],
              unaccountedMB: 4699,
            },
            workers: [],
          },
        }),
      );
    });

    expect(await screen.findByText("Compute workers / VRAM")).toBeInTheDocument();
    expect(screen.getByText("Outside this container")).toBeInTheDocument();
  });
});
