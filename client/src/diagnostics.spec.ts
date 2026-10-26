describe("client diagnostics session id", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("falls back to an in-memory session id when sessionStorage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Blocked", "SecurityError");
    });

    const diagnostics = await import("./diagnostics");

    const firstId = diagnostics.getClientSessionId();
    const secondId = diagnostics.getClientSessionId();

    expect(firstId).toMatch(/.+/);
    expect(secondId).toBe(firstId);
  });
});

describe("client diagnostics flush", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("drains the queue in bounded batches and only asks for keepalive when the body fits", async () => {
    const bodies: Array<{ events: unknown[]; keepalive: boolean | undefined }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        bodies.push({
          events: (JSON.parse(init.body as string) as { events: unknown[] }).events,
          keepalive: init.keepalive,
        });
        return Promise.resolve(new Response(null, { status: 202 }));
      }),
    );

    const diagnostics = await import("./diagnostics");
    const bigMessage = "x".repeat(2_000);
    for (let i = 0; i < 120; i++) {
      diagnostics.logClientEvent({ level: "info", event: `e${i}`, message: bigMessage });
    }
    await diagnostics.flushClientDiagnostics();

    expect(bodies.map((b) => b.events.length)).toEqual([50, 50, 20]);
    // 50 x ~2 KB is past the browser's 64 KiB keepalive ceiling.
    expect(bodies[0].keepalive).toBe(false);
  });

  it("keeps a failed batch for retry but caps the queue", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("offline"))),
    );
    const diagnostics = await import("./diagnostics");
    for (let i = 0; i < 700; i++) {
      diagnostics.logClientEvent({ level: "info", event: `e${i}` });
    }
    await diagnostics.flushClientDiagnostics();

    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        for (const e of (
          JSON.parse(init.body as string) as { events: Array<{ event: string }> }
        ).events) {
          sent.push(e.event);
        }
        return Promise.resolve(new Response(null, { status: 202 }));
      }),
    );
    for (let i = 0; i < 20; i++) await diagnostics.flushClientDiagnostics();

    expect(sent).toHaveLength(500);
    expect(sent[0]).toBe("e200");
    expect(sent.at(-1)).toBe("e699");
  });
});
