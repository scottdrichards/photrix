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
