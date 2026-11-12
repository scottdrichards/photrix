import { whenNetworkQuiet } from "./whenNetworkQuiet";

describe("whenNetworkQuiet", () => {
  const observers: Array<() => void> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    observers.length = 0;
    vi.stubGlobal(
      "PerformanceObserver",
      class {
        private readonly callback: () => void;
        constructor(callback: () => void) {
          this.callback = callback;
        }
        observe() {
          observers.push(this.callback);
        }
        disconnect() {
          observers.splice(observers.indexOf(this.callback), 1);
        }
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const resourceFinished = () => observers.forEach((notify) => notify());

  it("runs after a quiet spell", () => {
    const work = vi.fn();
    whenNetworkQuiet(work, { quietMs: 1000, maxWaitMs: 10_000 });
    vi.advanceTimersByTime(999);
    expect(work).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("waits while resources keep arriving", () => {
    const work = vi.fn();
    whenNetworkQuiet(work, { quietMs: 1000, maxWaitMs: 10_000 });
    for (let i = 0; i < 5; i += 1) {
      vi.advanceTimersByTime(800);
      resourceFinished();
    }
    expect(work).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("gives up waiting at the deadline, and runs only once", () => {
    const work = vi.fn();
    whenNetworkQuiet(work, { quietMs: 1000, maxWaitMs: 3000 });
    for (let i = 0; i < 10; i += 1) {
      vi.advanceTimersByTime(500);
      resourceFinished();
    }
    expect(work).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(work).toHaveBeenCalledTimes(1);
    expect(observers).toHaveLength(0);
  });

  it("does nothing once cancelled", () => {
    const work = vi.fn();
    const cancel = whenNetworkQuiet(work, { quietMs: 1000, maxWaitMs: 3000 });
    cancel();
    vi.advanceTimersByTime(60_000);
    expect(work).not.toHaveBeenCalled();
  });

  it("falls back to the quiet timer where resource timing is missing", () => {
    vi.stubGlobal("PerformanceObserver", undefined);
    const work = vi.fn();
    whenNetworkQuiet(work, { quietMs: 1000, maxWaitMs: 10_000 });
    vi.advanceTimersByTime(1000);
    expect(work).toHaveBeenCalledTimes(1);
  });
});
