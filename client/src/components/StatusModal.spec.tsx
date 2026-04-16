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
      onUpdate?.({
        databaseSize: 10,
        scannedFilesCount: 8,
        queues: { pending: 3, processing: 1 },
        queueSummary: {
          completed: {
            image: { count: 1, sizeBytes: 1024 * 1024 },
            video: { count: 1, sizeBytes: 2 * 1024 * 1024, durationMilliseconds: 3000 },
          },
          active: {
            image: { count: 1, sizeBytes: 512 * 1024 },
            video: { count: 0, sizeBytes: 0, durationMilliseconds: 0 },
          },
          userBlocked: {
            image: { count: 0, sizeBytes: 0 },
            video: { count: 1, sizeBytes: 256 * 1024, durationMilliseconds: 1200 },
          },
          userImplicit: {
            image: { count: 1, sizeBytes: 128 * 1024 },
            video: { count: 0, sizeBytes: 0, durationMilliseconds: 0 },
          },
          background: {
            image: { count: 1, sizeBytes: 64 * 1024 },
            video: { count: 1, sizeBytes: 64 * 1024, durationMilliseconds: 900 },
          },
        },
        pending: { info: 2, exif: 1 },
        maintenance: { exifActive: true },
        progress: {
          overall: { completed: 7, total: 10, percent: 0.7 },
          scanned: { completed: 8, total: 10, percent: 0.8 },
          info: { completed: 8, total: 10, percent: 0.8 },
          exif: { completed: 7, total: 10, percent: 0.7 },
        },
        recent: {
          exif: {
            folder: "trip/",
            fileName: "a.jpg",
            completedAt: "2026-03-05T12:00:00.000Z",
          },
        },
      });
    });

    expect(await screen.findByText(/Database Size:/)).toBeInTheDocument();
    expect(screen.getByText(/10 files/)).toBeInTheDocument();
    expect(screen.getByText(/Queue:/)).toBeInTheDocument();
    expect(screen.getByText(/3 waiting/)).toBeInTheDocument();
    expect(screen.getByText("Queue by disk size")).toBeInTheDocument();
    expect(screen.getByText(/completed:/)).toBeInTheDocument();
    expect(screen.getByText("Recent activity")).toBeInTheDocument();
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
      onUpdate?.({
        databaseSize: 10,
        scannedFilesCount: 8,
        queues: { pending: 3, processing: 1 },
        queueSummary: {
          completed: {
            image: { count: 0, sizeBytes: 0 },
            video: { count: 0, sizeBytes: 0, durationMilliseconds: 0 },
          },
          active: {
            image: { count: 0, sizeBytes: 0 },
            video: { count: 0, sizeBytes: 0, durationMilliseconds: 0 },
          },
          userBlocked: {
            image: { count: 0, sizeBytes: 0 },
            video: { count: 0, sizeBytes: 0, durationMilliseconds: 0 },
          },
          userImplicit: {
            image: { count: 0, sizeBytes: 0 },
            video: { count: 0, sizeBytes: 0, durationMilliseconds: 0 },
          },
          background: {
            image: { count: 0, sizeBytes: 0 },
            video: { count: 0, sizeBytes: 0, durationMilliseconds: 0 },
          },
        },
        pending: { info: 2, exif: 1 },
        maintenance: {
          exifActive: true,
          backgroundTasksEnabled: true,
        },
        progress: {
          overall: { completed: 7, total: 10, percent: 0.7 },
          scanned: { completed: 8, total: 10, percent: 0.8 },
          info: { completed: 8, total: 10, percent: 0.8 },
          exif: { completed: 7, total: 10, percent: 0.7 },
        },
        recent: {
          exif: {
            folder: "trip/",
            fileName: "a.jpg",
            completedAt: "2026-03-05T12:00:00.000Z",
          },
        },
      });
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

  it("renders idle worker and empty recent activity across progress updates", async () => {
    const unsubscribe = vi.fn();
    let onUpdate: ((status: unknown) => void) | undefined;

    subscribeStatusStreamMock.mockImplementation((update) => {
      onUpdate = update as (status: unknown) => void;
      return unsubscribe;
    });

    render(<StatusModal isOpen={true} onDismiss={vi.fn()} />);

    await act(async () => {
      onUpdate?.({
        databaseSize: 10,
        scannedFilesCount: 8,
        queues: { pending: 3, processing: 1 },
        queueSummary: {
          completed: {
            image: { count: 0, sizeBytes: 0 },
            video: { count: 0, sizeBytes: 0, durationMilliseconds: 0 },
          },
          active: {
            image: { count: 0, sizeBytes: 0 },
            video: { count: 0, sizeBytes: 0, durationMilliseconds: 0 },
          },
          userBlocked: {
            image: { count: 0, sizeBytes: 0 },
            video: { count: 0, sizeBytes: 0, durationMilliseconds: 0 },
          },
          userImplicit: {
            image: { count: 0, sizeBytes: 0 },
            video: { count: 0, sizeBytes: 0, durationMilliseconds: 0 },
          },
          background: {
            image: { count: 0, sizeBytes: 0 },
            video: { count: 0, sizeBytes: 0, durationMilliseconds: 0 },
          },
        },
        pending: { info: 2, exif: 20 },
        maintenance: { exifActive: false },
        progress: {
          overall: { completed: 10, total: 40, percent: 0.25 },
          scanned: { completed: 10, total: 40, percent: 0.25 },
          info: { completed: 10, total: 40, percent: 0.25 },
          exif: { completed: 10, total: 40, percent: 0.25 },
        },
        recent: { exif: null },
      });
      onUpdate?.({
        databaseSize: 10,
        scannedFilesCount: 8,
        queues: { pending: 3, processing: 1 },
        queueSummary: {
          completed: {
            image: { count: 1, sizeBytes: 1024 },
            video: { count: 0, sizeBytes: 0, durationMilliseconds: 0 },
          },
          active: {
            image: { count: 0, sizeBytes: 0 },
            video: { count: 0, sizeBytes: 0, durationMilliseconds: 0 },
          },
          userBlocked: {
            image: { count: 0, sizeBytes: 0 },
            video: { count: 0, sizeBytes: 0, durationMilliseconds: 0 },
          },
          userImplicit: {
            image: { count: 0, sizeBytes: 0 },
            video: { count: 0, sizeBytes: 0, durationMilliseconds: 0 },
          },
          background: {
            image: { count: 0, sizeBytes: 0 },
            video: { count: 0, sizeBytes: 0, durationMilliseconds: 0 },
          },
        },
        pending: { info: 2, exif: 10 },
        maintenance: { exifActive: false },
        progress: {
          overall: { completed: 20, total: 40, percent: 0.5 },
          scanned: { completed: 20, total: 40, percent: 0.5 },
          info: { completed: 20, total: 40, percent: 0.5 },
          exif: { completed: 20, total: 40, percent: 0.5 },
        },
        recent: { exif: null },
      });
    });

    expect(await screen.findByText(/EXIF worker:/)).toBeInTheDocument();
    expect(screen.getAllByText("idle").length).toBeGreaterThan(0);
    expect(screen.getByText("No activity yet")).toBeInTheDocument();
  });

  it("unsubscribes on unmount", () => {
    const unsubscribe = vi.fn();
    subscribeStatusStreamMock.mockReturnValue(unsubscribe);

    const { unmount } = render(<StatusModal isOpen={true} onDismiss={vi.fn()} />);

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
