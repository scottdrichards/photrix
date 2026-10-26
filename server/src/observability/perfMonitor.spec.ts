import { afterEach, describe, expect, it } from "@jest/globals";
import {
  getPerfSnapshot,
  recordRequestEnd,
  recordRequestStart,
  resetPerfMonitorForTests,
  routeKey,
  startPerfMonitor,
  stopPerfMonitor,
} from "./perfMonitor.ts";
import { clearDiagnosticsEvents, listDiagnosticsEvents } from "./diagnosticsStore.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  stopPerfMonitor();
  resetPerfMonitorForTests();
  clearDiagnosticsEvents();
});

describe("routeKey", () => {
  it("groups requests by route without leaking library paths or search text", () => {
    expect(
      routeKey("GET", "/api/files/Family%2FKids%2Fbeach.jpg?representation=preview"),
    ).toBe("GET /api/files/:path [preview]");
    expect(routeKey("GET", "/api/search?q=grandma")).toBe("GET /api/search");
  });

  it("tells the HLS master, variant playlist and segment requests apart", () => {
    expect(routeKey("GET", "/api/files/a.mp4?representation=hls")).toBe(
      "GET /api/files/:path [hls-master]",
    );
    expect(routeKey("GET", "/api/files/a.mp4?representation=hls&variant=720")).toBe(
      "GET /api/files/:path [hls-variant]",
    );
    expect(
      routeKey("GET", "/api/files/a.mp4?representation=hls&variant=720&segment=3"),
    ).toBe("GET /api/files/:path [hls-segment]");
  });

  it("ignores representation values that are not plain identifiers", () => {
    expect(routeKey("GET", "/api/files/a.jpg?representation=Grandma's%20house")).toBe(
      "GET /api/files/:path",
    );
  });
});

describe("perf snapshot", () => {
  it("reports per-route latency percentiles and errors, slowest total first", () => {
    for (let i = 1; i <= 100; i++) {
      recordRequestStart(`r${i}`, "GET /api/search");
      recordRequestEnd(`r${i}`, {
        route: "GET /api/search",
        statusCode: 200,
        durationMs: i,
        spans: [],
      });
    }
    recordRequestStart("x", "GET /api/folders/:path");
    recordRequestEnd("x", {
      route: "GET /api/folders/:path",
      statusCode: 500,
      durationMs: 3,
      spans: [],
    });

    const { routes } = getPerfSnapshot();

    expect(routes[0]).toMatchObject({
      route: "GET /api/search",
      count: 100,
      errors: 0,
      p50Ms: 50,
      p95Ms: 95,
      maxMs: 100,
    });
    expect(routes[1]).toMatchObject({ route: "GET /api/folders/:path", errors: 1 });
  });

  it("lists requests still in flight, oldest first", () => {
    recordRequestStart("a", "GET /api/search");
    recordRequestStart("b", "GET /api/files/:path [hls-segment]");
    recordRequestEnd("a", {
      route: "GET /api/search",
      statusCode: 200,
      durationMs: 1,
      spans: [],
    });

    expect(getPerfSnapshot().inFlight.map((r) => r.route)).toEqual([
      "GET /api/files/:path [hls-segment]",
    ]);
  });

  it("records a slow request with its span breakdown so it can be reconstructed", () => {
    recordRequestStart("slow", "GET /api/search");
    recordRequestEnd("slow", {
      route: "GET /api/search",
      statusCode: 200,
      durationMs: 4_000,
      spans: [
        { name: "db.query", category: "db", durationMs: 3_500 },
        { name: "embed", category: "conversion", durationMs: 400 },
      ],
    });

    const [event] = listDiagnosticsEvents().filter(
      (e) => e.event === "server.request.slow",
    );
    expect(event.data).toMatchObject({
      route: "GET /api/search",
      durationMs: 4_000,
      categoryMs: { db: 3_500, conversion: 400 },
      topSpans: [
        { name: "db.query", durationMs: 3_500 },
        { name: "embed", durationMs: 400 },
      ],
    });
  });

  it("does not flag long-lived streams as slow", () => {
    recordRequestStart("sse", "GET /api/status/stream");
    recordRequestEnd("sse", {
      route: "GET /api/status/stream",
      statusCode: 200,
      durationMs: 600_000,
      spans: [],
    });

    expect(listDiagnosticsEvents().some((e) => e.event === "server.request.slow")).toBe(
      false,
    );
  });
});

describe("event loop stall detection", () => {
  it("records what was in flight when synchronous work blocked the server", async () => {
    startPerfMonitor();
    recordRequestStart("busy", "GET /api/search");
    await sleep(150);

    const blockUntil = Date.now() + 400;
    while (Date.now() < blockUntil) {
      // Simulate synchronous work hogging the event loop.
    }
    await sleep(150);

    const stall = listDiagnosticsEvents().find(
      (e) => e.event === "server.eventloop.stall",
    );
    expect(stall?.data).toMatchObject({ inFlight: ["GET /api/search"] });
    expect(stall?.data?.blockedMs).toBeGreaterThanOrEqual(250);
    expect(getPerfSnapshot().eventLoop.stalls).toBeGreaterThanOrEqual(1);
  });
});
