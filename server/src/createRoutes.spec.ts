import { describe, expect, it } from "@jest/globals";
import { createRoutes, matchesRoute, type Route, type RouteDeps } from "./createRoutes.ts";

// The routes are only listed here, never called, so their dependencies are never touched.
const routes = createRoutes({ database: { analysis: {} } } as unknown as RouteDeps);

/** A concrete request that `route` handles: its exact path, or its prefix plus a segment. */
const sampleRequest = (route: Route) => ({
  method: route.method ?? "GET",
  pathname: route.path.endsWith("*") ? `${route.path.slice(0, -1)}x` : route.path,
});

describe("matchesRoute", () => {
  const exact: Route = { method: "GET", path: "/api/a", shareLink: "allowed", handle: () => {} };
  const prefix: Route = { path: "/api/a/*", shareLink: "allowed", handle: () => {} };

  it("matches an exact path only when the method also matches", () => {
    expect(matchesRoute(exact, "GET", "/api/a")).toBe(true);
    expect(matchesRoute(exact, "POST", "/api/a")).toBe(false);
    expect(matchesRoute(exact, "GET", "/api/a/b")).toBe(false);
  });

  it("matches a `*` path as a prefix, for any method when none is given", () => {
    expect(matchesRoute(prefix, "PATCH", "/api/a/b/c")).toBe(true);
    expect(matchesRoute(prefix, "GET", "/api/ab")).toBe(false);
  });
});

describe("createRoutes", () => {
  it("puts every /api route under /api", () => {
    for (const route of routes) expect(route.path).toMatch(/^\/api\//);
  });

  // The first matching route wins, so a route listed after a broader prefix
  // that covers it would never run.
  it.each(routes.map((route) => [route.method ?? "*", route.path, route]))(
    "reaches %s %s (no earlier route shadows it)",
    (_method, _path, route) => {
      const { method, pathname } = sampleRequest(route as Route);
      const firstMatch = routes.find((candidate) => matchesRoute(candidate, method, pathname));
      expect(firstMatch).toBe(route);
    },
  );
});
