import {
  clearShareToken,
  clearToken,
  extractUrlToken,
  getAccountToken,
  getShareToken,
  getToken,
  hasAccountSession,
  isShareView,
  setToken,
} from "./auth";

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

/**
 * Feedback #33: opening a share link while signed in stranded the owner in the
 * share's scope — going to the root domain did not restore their library. The
 * share token was being written over the account session's storage key, so the
 * account session no longer existed to go back to.
 */
describe("share link does not clobber the account session", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.pushState(null, "", "/");
  });

  afterEach(() => {
    window.localStorage.clear();
    window.history.pushState(null, "", "/");
  });

  const openShareLink = (token = "share-token") => {
    window.history.pushState(null, "", `/?token=${token}`);
    extractUrlToken();
  };

  it("keeps the account token intact when a share link is opened", () => {
    setToken("account-token");
    openShareLink();

    expect(getAccountToken()).toBe("account-token");
    expect(hasAccountSession()).toBe(true);
  });

  it("authenticates with the share token while on the share URL", () => {
    setToken("account-token");
    openShareLink();

    expect(isShareView()).toBe(true);
    expect(getToken()).toBe("share-token");
  });

  it("restores full access as soon as the share URL is left", () => {
    setToken("account-token");
    openShareLink();
    expect(getToken()).toBe("share-token");

    // Navigate back to the root domain — the fix for #33.
    window.history.pushState(null, "", "/");

    expect(isShareView()).toBe(false);
    expect(getToken()).toBe("account-token");
  });

  it("works for a visitor with no account at all", () => {
    openShareLink();

    expect(getToken()).toBe("share-token");
    expect(hasAccountSession()).toBe(false);
  });

  it("remembers the share token after the URL param is dropped mid-share-view", () => {
    openShareLink("share-token");
    expect(getShareToken()).toBe("share-token");
  });

  it("clearing the share token leaves the account session signed in", () => {
    setToken("account-token");
    openShareLink();

    clearShareToken();

    expect(hasAccountSession()).toBe(true);
    // Still on the share URL, so the URL's own token is what authenticates.
    expect(getToken()).toBe("share-token");
    window.history.pushState(null, "", "/");
    expect(getToken()).toBe("account-token");
  });

  it("signing out clears both credentials", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response);
    setToken("account-token");
    openShareLink();

    const { logout } = await import("./auth");
    await logout();

    expect(getAccountToken()).toBeNull();
    expect(getShareToken()).toBe("share-token"); // only the URL's, storage is cleared
    window.history.pushState(null, "", "/");
    expect(getToken()).toBeNull();
  });
});
