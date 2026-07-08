import { clearToken, extractUrlToken, getToken, setToken } from "./auth";

describe("auth storage access", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.pushState(null, "", "/");
  });

  it("does not throw when localStorage access is denied", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("Blocked", "SecurityError");
    });

    expect(getToken()).toBeNull();
    expect(() => setToken("token-1")).not.toThrow();
    expect(() => clearToken()).not.toThrow();
  });

  it("does not throw when extracting a share token with blocked storage", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Blocked", "SecurityError");
    });
    window.history.pushState(null, "", "/shared?token=share-token");

    expect(() => extractUrlToken()).not.toThrow();
  });
});
