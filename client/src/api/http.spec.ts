import { afterEach, describe, expect, it, vi } from "vitest";

const logClientEvent = vi.fn();
vi.mock("../diagnostics", () => ({
  logClientEvent: (...args: unknown[]) => logClientEvent(...args),
  createClientOperationId: () => "id",
  getClientSessionId: () => "session",
}));

import { fetchWithDiagnostics } from "./http";

afterEach(() => {
  logClientEvent.mockReset();
  vi.unstubAllGlobals();
});

describe("fetchWithDiagnostics", () => {
  it("records a request cancelled with a custom reason as aborted, not failed", async () => {
    const controller = new AbortController();
    controller.abort("disposed");
    vi.stubGlobal("fetch", () => Promise.reject(controller.signal.reason));

    await expect(
      fetchWithDiagnostics("/api/files/", "fetch photos", { signal: controller.signal }),
    ).rejects.toBe("disposed");

    expect(logClientEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ event: "client.request.aborted", level: "warn" }),
    );
  });

  it("records how long a request took", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("{}", { status: 200 })));

    await fetchWithDiagnostics("/api/status", "fetch status");

    expect(logClientEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        event: "client.request.completed",
        data: { durationMs: expect.any(Number) },
      }),
    );
  });
});
