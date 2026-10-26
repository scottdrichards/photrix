import { logClientEvent } from "./diagnostics";

// A frame this long is a visible freeze (scroll/typing stops). Shorter long
// frames are too common to be worth a diagnostics event each.
const FROZEN_FRAME_MS = 200;

type ScriptTiming = {
  duration: number;
  invoker?: string;
  sourceURL?: string;
  sourceFunctionName?: string;
};
type AnimationFrameTiming = {
  duration: number;
  startTime: number;
  blockingDuration?: number;
  scripts?: ScriptTiming[];
};

/**
 * Browser-side half of "what made it slow": main-thread freezes (with the
 * scripts that caused them, where the browser supports Long Animation Frames)
 * and page-load timing, sent into the same diagnostics stream as requests and
 * video playback so a report (`/api/diagnostics/report`) shows them in order.
 */
export const startClientPerfMonitor = () => {
  if (typeof PerformanceObserver === "undefined") return;
  const supported = PerformanceObserver.supportedEntryTypes ?? [];
  const frameType = supported.includes("long-animation-frame")
    ? "long-animation-frame"
    : supported.includes("longtask")
      ? "longtask"
      : null;

  if (frameType) {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as unknown as AnimationFrameTiming[]) {
        if (entry.duration < FROZEN_FRAME_MS) continue;
        logClientEvent({
          level: "warn",
          event: "client.ui.frozen",
          message: `UI froze for ${Math.round(entry.duration)}ms`,
          data: {
            durationMs: Math.round(entry.duration),
            atMs: Math.round(entry.startTime),
            ...(entry.blockingDuration != null
              ? { blockingMs: Math.round(entry.blockingDuration) }
              : {}),
            ...(entry.scripts
              ? {
                  scripts: [...entry.scripts]
                    .sort((a, b) => b.duration - a.duration)
                    .slice(0, 3)
                    .map((script) => ({
                      durationMs: Math.round(script.duration),
                      invoker: script.invoker,
                      source: [script.sourceURL, script.sourceFunctionName]
                        .filter(Boolean)
                        .join(" "),
                    })),
                }
              : {}),
          },
        });
      }
    }).observe({ type: frameType, buffered: true });
  }

  if (supported.includes("navigation")) {
    const navigationObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as PerformanceNavigationTiming[]) {
        if (!entry.loadEventEnd) continue;
        // The completed entry can be delivered more than once.
        navigationObserver.disconnect();
        logClientEvent({
          level: "info",
          event: "client.page.loaded",
          message: `Page loaded in ${Math.round(entry.loadEventEnd)}ms`,
          data: {
            ttfbMs: Math.round(entry.responseStart),
            domContentLoadedMs: Math.round(entry.domContentLoadedEventEnd),
            loadMs: Math.round(entry.loadEventEnd),
            transferBytes: entry.transferSize,
          },
        });
        return;
      }
    });
    navigationObserver.observe({ type: "navigation", buffered: true });
  }
};
