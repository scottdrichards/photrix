// The signed-in account's session. Only login/passkey ever writes this.
const TOKEN_KEY = "photrix_auth_token";
// A share link's token, kept strictly separate from the account session. Opening
// a share link used to overwrite TOKEN_KEY, which destroyed the owner's session:
// they were then stuck in the share's scope, and returning to the root domain did
// not restore their library because the share token *was* their stored token.
const SHARE_TOKEN_KEY = "photrix_share_token";

const readLocalStorage = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const writeLocalStorage = (key: string, value: string): void => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage access failures so the app can still render.
  }
};

const removeLocalStorage = (key: string): void => {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore storage access failures so logout still clears in-memory auth state.
  }
};

/** The share token carried by the current URL, if this page is a share view. */
const shareTokenFromUrl = (): string | null => {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("token");
};

/**
 * True while the current URL carries a share token. Share scoping is a property
 * of *where you are*, not of the browser profile: leave the share URL and you are
 * yourself again.
 */
export const isShareView = (): boolean => shareTokenFromUrl() !== null;

/** The signed-in account's token, independent of any share link being viewed. */
export const getAccountToken = (): string | null => {
  if (typeof window === "undefined") return null;
  return readLocalStorage(TOKEN_KEY);
};

/** True when a real account session exists (regardless of share view). */
export const hasAccountSession = (): boolean => getAccountToken() !== null;

export const getShareToken = (): string | null => {
  if (typeof window === "undefined") return null;
  return shareTokenFromUrl() ?? readLocalStorage(SHARE_TOKEN_KEY);
};

/**
 * The token to authenticate API calls with: the share token while viewing a share
 * link (so the view really is limited to what was shared, for owner and guest
 * alike), the account session everywhere else — which is what lets an
 * authenticated owner return to their full library just by leaving the share URL.
 */
export const getToken = (): string | null => {
  if (typeof window === "undefined") {
    return null;
  }
  if (isShareView()) {
    return getShareToken() ?? getAccountToken();
  }
  return getAccountToken();
};

export const setToken = (token: string) => {
  if (typeof window === "undefined") {
    return;
  }
  writeLocalStorage(TOKEN_KEY, token);
};

export const clearToken = () => {
  if (typeof window === "undefined") {
    return;
  }
  removeLocalStorage(TOKEN_KEY);
};

export const clearShareToken = () => {
  if (typeof window === "undefined") {
    return;
  }
  removeLocalStorage(SHARE_TOKEN_KEY);
};

export const getAuthHeaders = (): Record<string, string> => {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
};

let onUnauthorizedCallback: (() => void) | null = null;

export const onUnauthorized = (cb: () => void) => {
  onUnauthorizedCallback = cb;
};

export const notifyUnauthorized = () => {
  onUnauthorizedCallback?.();
};

// If the URL contains ?token=, remember it as the *share* token (used by
// self-authenticating share links). Deliberately does not touch the account
// session, so an owner who opens a share link is still signed in underneath it
// and gets their whole library back the moment they leave the share URL.
export const extractUrlToken = (): void => {
  if (typeof window === "undefined") {
    return;
  }
  const urlToken = shareTokenFromUrl();
  if (urlToken) writeLocalStorage(SHARE_TOKEN_KEY, urlToken);
};

// Returns true if authenticated or auth is not required, false if login needed.
export const initAuth = async (): Promise<boolean> => {
  const token = getToken();
  const headers: Record<string, string> = token
    ? { Authorization: `Bearer ${token}` }
    : {};
  try {
    const response = await fetch("/api/status", { headers });
    if (response.ok) return true;
    if (response.status === 401) {
      // Drop only the credential that was actually rejected: a dead share link
      // must not sign the account out.
      if (isShareView()) {
        clearShareToken();
        return hasAccountSession();
      }
      clearToken();
      return false;
    }
  } catch {
    // Network error — optimistically show the app
  }
  return true;
};

export const login = async (username: string, password: string): Promise<boolean> => {
  const response = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) return false;
  const data = (await response.json()) as { token?: string };
  if (!data.token) return false;
  setToken(data.token);
  return true;
};

// --- Passkey support ---

export const isPasskeyAvailable = async (): Promise<boolean> => {
  try {
    const { browserSupportsWebAuthn } = await import("@simplewebauthn/browser");
    return browserSupportsWebAuthn();
  } catch {
    return false;
  }
};

export const loginWithPasskey = async (): Promise<boolean> => {
  try {
    const { startAuthentication } = await import("@simplewebauthn/browser");

    const optRes = await fetch("/api/auth/passkey/authentication-options", { method: "POST" });
    if (!optRes.ok) return false;
    const { options, sessionId } = (await optRes.json()) as {
      options: Parameters<typeof startAuthentication>[0]["optionsJSON"];
      sessionId: string;
    };

    const response = await startAuthentication({ optionsJSON: options });

    const verifyRes = await fetch("/api/auth/passkey/authentication-verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, response }),
    });
    if (!verifyRes.ok) return false;
    const data = (await verifyRes.json()) as { token?: string };
    if (!data.token) return false;
    setToken(data.token);
    return true;
  } catch {
    return false;
  }
};

export const registerPasskey = async (username: string): Promise<boolean> => {
  try {
    const { startRegistration } = await import("@simplewebauthn/browser");

    const optRes = await fetch("/api/auth/passkey/registration-options", {
      method: "POST",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ username }),
    });
    if (!optRes.ok) return false;
    const { options, sessionId } = (await optRes.json()) as {
      options: Parameters<typeof startRegistration>[0]["optionsJSON"];
      sessionId: string;
    };

    const response = await startRegistration({ optionsJSON: options });

    const verifyRes = await fetch("/api/auth/passkey/registration-verify", {
      method: "POST",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, response }),
    });
    return verifyRes.ok;
  } catch {
    return false;
  }
};

export const logout = async () => {
  const token = getAccountToken();
  clearToken();
  clearShareToken();
  if (token) {
    await fetch("/api/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    }).catch(() => {});
  }
};
