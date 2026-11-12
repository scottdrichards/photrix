/**
 * Runs `work` once the page has stopped fetching things for a moment, so a
 * fetch nobody is waiting for doesn't take bandwidth from one somebody is.
 *
 * "Quiet" is `quietMs` without a resource finishing. On a slow link the first
 * screen's thumbnails arrive one after another for seconds, and a fixed delay
 * lands in the middle of them: preloading the viewer 2 s after the page loaded
 * cost the first tiles about half the bundle's saving at 3 Mbit.
 *
 * `maxWaitMs` bounds the wait for a page that never goes quiet. Returns a
 * function that cancels the run.
 */
export const whenNetworkQuiet = (
  work: () => void,
  { quietMs = 1_500, maxWaitMs = 20_000 }: { quietMs?: number; maxWaitMs?: number } = {},
): (() => void) => {
  const timers: { quiet?: number; deadline?: number } = {};
  const observer =
    typeof PerformanceObserver === "undefined" ? null : new PerformanceObserver(() => restart());

  const stop = () => {
    window.clearTimeout(timers.quiet);
    window.clearTimeout(timers.deadline);
    observer?.disconnect();
  };
  const run = () => {
    stop();
    work();
  };
  function restart() {
    window.clearTimeout(timers.quiet);
    timers.quiet = window.setTimeout(run, quietMs);
  }

  restart();
  timers.deadline = window.setTimeout(run, maxWaitMs);
  observer?.observe({ type: "resource", buffered: false });
  return stop;
};
