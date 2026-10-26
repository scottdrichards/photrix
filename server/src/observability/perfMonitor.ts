import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import { recordServerDiagnosticEvent } from "./diagnosticsStore.ts";
import { getLogger } from "./logger.ts";
import { redactRequestPath } from "./privacy.ts";

/**
 * Always-on, in-process answer to "what is making the server slow right now?"
 * without Jaeger: per-route latency, requests in flight, event-loop health, and
 * a diagnostics event (with span breakdown + what else was running) for every
 * slow request and every event-loop stall. Read it at `GET /api/diagnostics/perf`
 * or bundled into `GET /api/diagnostics/report`. Everything keyed by route goes
 * through `redactRequestPath`, so no library path or search text is retained.
 */

const log = getLogger("perfMonitor");

const SAMPLES_PER_ROUTE = 200;
const SLOW_REQUEST_MS = Number(process.env.PHOTRIX_SLOW_REQUEST_MS) || 1_000;
const STALL_TICK_MS = 100;
// A tick this late means synchronous work blocked every request for that long.
const STALL_THRESHOLD_MS = 200;
const RECENT_STALLS = 20;
const HISTORY_WINDOW_MS = 60_000;
const HISTORY_WINDOWS = 15;
// Held open for as long as the client wants; their duration is not latency.
const LONG_LIVED_ROUTES = new Set(["GET /api/status/stream", "GET /api/network-probe"]);

type SpanSample = { name: string; category: string; durationMs: number };
type RouteStats = {
  count: number;
  errors: number;
  totalMs: number;
  maxMs: number;
  samples: number[];
};
type Stall = { at: string; blockedMs: number; inFlight: string[] };
type LoopWindow = { endedAt: string; p50Ms: number; p99Ms: number; maxMs: number };

const routes = new Map<string, RouteStats>();
const inFlight = new Map<string, { route: string; startedAt: number }>();
const recentStalls: Stall[] = [];
const loopHistory: LoopWindow[] = [];
let stallCount = 0;
let histogram: IntervalHistogram | null = null;
let timers: ReturnType<typeof setInterval>[] = [];

const ms = (ns: number) => Math.round((ns / 1e6) * 10) / 10;
const loopStats = (h: IntervalHistogram) => ({
  p50Ms: ms(h.percentile(50)),
  p99Ms: ms(h.percentile(99)),
  maxMs: ms(h.max),
});

/** `METHOD /route [representation]`, e.g. `GET /api/files/:path [hls-segment]`. */
export const routeKey = (method: string, url: string): string => {
  const params = new URL(url, "http://localhost").searchParams;
  let representation = params.get("representation");
  if (representation && !/^[a-zA-Z0-9-]{1,32}$/.test(representation))
    representation = null;
  if (representation === "hls") {
    representation = params.has("segment")
      ? "hls-segment"
      : params.has("variant")
        ? "hls-variant"
        : "hls-master";
  }
  return `${method} ${redactRequestPath(url)}${representation ? ` [${representation}]` : ""}`;
};

const inFlightRoutes = () =>
  [...inFlight.values()].sort((a, b) => a.startedAt - b.startedAt).map((r) => r.route);

export const recordRequestStart = (requestId: string, route: string): void => {
  inFlight.set(requestId, { route, startedAt: Date.now() });
};

export const recordRequestEnd = (
  requestId: string,
  request: { route: string; statusCode: number; durationMs: number; spans: SpanSample[] },
): void => {
  const { route, statusCode, durationMs, spans } = request;
  inFlight.delete(requestId);

  const stats = routes.get(route) ?? {
    count: 0,
    errors: 0,
    totalMs: 0,
    maxMs: 0,
    samples: [],
  };
  routes.set(route, stats);
  stats.count += 1;
  if (statusCode >= 500) stats.errors += 1;
  stats.totalMs += durationMs;
  stats.maxMs = Math.max(stats.maxMs, durationMs);
  stats.samples.push(durationMs);
  if (stats.samples.length > SAMPLES_PER_ROUTE) stats.samples.shift();

  if (durationMs < SLOW_REQUEST_MS || LONG_LIVED_ROUTES.has(route)) return;
  const categoryMs: Record<string, number> = {};
  for (const span of spans)
    categoryMs[span.category] = (categoryMs[span.category] ?? 0) + span.durationMs;
  recordServerDiagnosticEvent({
    level: "warn",
    event: "server.request.slow",
    message: `${route} took ${Math.round(durationMs)}ms`,
    data: {
      route,
      statusCode,
      durationMs: Math.round(durationMs),
      categoryMs,
      topSpans: [...spans]
        .sort((a, b) => b.durationMs - a.durationMs)
        .slice(0, 5)
        .map(({ name, category, durationMs: spanMs }) => ({
          name,
          category,
          durationMs: Math.round(spanMs),
        })),
      concurrentRequests: inFlightRoutes(),
      eventLoop: histogram ? loopStats(histogram) : null,
      rssMb: Math.round(process.memoryUsage.rss() / 1e6),
    },
  });
};

const percentile = (sorted: number[], p: number) =>
  sorted.length ? Math.round(sorted[Math.ceil(p * sorted.length) - 1]) : 0;

export const getPerfSnapshot = () => {
  const now = Date.now();
  return {
    uptimeS: Math.round(process.uptime()),
    memoryMb: Object.fromEntries(
      Object.entries(process.memoryUsage()).map(([key, bytes]) => [
        key,
        Math.round(bytes / 1e6),
      ]),
    ),
    eventLoop: {
      currentWindow: histogram ? loopStats(histogram) : null,
      history: loopHistory,
      stalls: stallCount,
      recentStalls,
    },
    inFlight: [...inFlight.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .map(({ route, startedAt }) => ({ route, ageMs: now - startedAt })),
    routes: [...routes.entries()]
      .map(([route, stats]) => {
        const sorted = [...stats.samples].sort((a, b) => a - b);
        return {
          route,
          count: stats.count,
          errors: stats.errors,
          totalMs: Math.round(stats.totalMs),
          p50Ms: percentile(sorted, 0.5),
          p95Ms: percentile(sorted, 0.95),
          maxMs: Math.round(stats.maxMs),
        };
      })
      .sort((a, b) => b.totalMs - a.totalMs),
  };
};

export const startPerfMonitor = (): void => {
  if (histogram) return;
  histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();

  let lastTick = performance.now();
  const stallTimer = setInterval(() => {
    const now = performance.now();
    const blockedMs = Math.round(now - lastTick - STALL_TICK_MS);
    lastTick = now;
    if (blockedMs < STALL_THRESHOLD_MS) return;
    stallCount += 1;
    const stall = { at: new Date().toISOString(), blockedMs, inFlight: inFlightRoutes() };
    recentStalls.push(stall);
    if (recentStalls.length > RECENT_STALLS) recentStalls.shift();
    log.warn(stall, `Event loop blocked for ${blockedMs}ms`);
    recordServerDiagnosticEvent({
      level: "warn",
      event: "server.eventloop.stall",
      message: `Event loop blocked for ${blockedMs}ms`,
      data: { blockedMs, inFlight: stall.inFlight },
    });
  }, STALL_TICK_MS);

  const historyTimer = setInterval(() => {
    if (!histogram) return;
    loopHistory.push({ endedAt: new Date().toISOString(), ...loopStats(histogram) });
    if (loopHistory.length > HISTORY_WINDOWS) loopHistory.shift();
    histogram.reset();
  }, HISTORY_WINDOW_MS);

  timers = [stallTimer, historyTimer];
  for (const timer of timers) timer.unref();
};

export const stopPerfMonitor = (): void => {
  for (const timer of timers) clearInterval(timer);
  timers = [];
  histogram?.disable();
  histogram = null;
};

export const resetPerfMonitorForTests = (): void => {
  routes.clear();
  inFlight.clear();
  recentStalls.length = 0;
  loopHistory.length = 0;
  stallCount = 0;
};
