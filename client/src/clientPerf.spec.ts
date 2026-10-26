import { afterEach, describe, expect, it, vi } from "vitest";

const logClientEvent = vi.fn();
vi.mock("./diagnostics", () => ({
  logClientEvent: (...args: unknown[]) => logClientEvent(...args),
}));

const observers = new Map<string, (list: { getEntries: () => unknown[] }) => void>();
class FakePerformanceObserver {
  static supportedEntryTypes = ["long-animation-frame", "navigation"];
  constructor(private callback: (list: { getEntries: () => unknown[] }) => void) {}
  observe({ type }: { type: string }) {
    observers.set(type, this.callback);
  }
  disconnect() {}
}
const emit = (type: string, entries: unknown[]) =>
  observers.get(type)?.({ getEntries: () => entries });

afterEach(() => {
  observers.clear();
  logClientEvent.mockReset();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("client perf monitor", () => {
  it("reports frames that froze the UI, with the scripts that caused them", async () => {
    vi.stubGlobal("PerformanceObserver", FakePerformanceObserver);
    const { startClientPerfMonitor } = await import("./clientPerf");
    startClientPerfMonitor();

    emit("long-animation-frame", [
      { duration: 90, startTime: 1, blockingDuration: 20, scripts: [] },
      {
        duration: 420,
        startTime: 5_000,
        blockingDuration: 370,
        scripts: [
          {
            duration: 400,
            invoker: "Response.json.then",
            sourceURL: "/assets/index.js",
            sourceFunctionName: "buildGrid",
          },
        ],
      },
    ]);

    expect(logClientEvent).toHaveBeenCalledTimes(1);
    expect(logClientEvent.mock.calls[0][0]).toMatchObject({
      event: "client.ui.frozen",
      data: {
        durationMs: 420,
        blockingMs: 370,
        scripts: [
          {
            durationMs: 400,
            invoker: "Response.json.then",
            source: "/assets/index.js buildGrid",
          },
        ],
      },
    });
  });

  it("reports how long the page took to load", async () => {
    vi.stubGlobal("PerformanceObserver", FakePerformanceObserver);
    const { startClientPerfMonitor } = await import("./clientPerf");
    startClientPerfMonitor();

    emit("navigation", [
      {
        responseStart: 120,
        domContentLoadedEventEnd: 800,
        loadEventEnd: 1_500,
        transferSize: 4_000,
      },
    ]);

    expect(logClientEvent.mock.calls[0][0]).toMatchObject({
      event: "client.page.loaded",
      data: { ttfbMs: 120, domContentLoadedMs: 800, loadMs: 1_500 },
    });
  });
});
