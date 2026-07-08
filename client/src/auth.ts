const TOKEN_KEY = "photrix_auth_token";

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

export const getToken = (): string | null => {
  if (typeof window === "undefined") {
    return null;
  }
  return readLocalStorage(TOKEN_KEY);
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

// If the URL contains ?token=, store it (used by self-authenticating share links).
export const extractUrlToken = (): void => {
  if (typeof window === "undefined") {
    return;
  }
  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get("token");
  if (urlToken) setToken(urlToken);
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
  const token = getToken();
  clearToken();
  if (token) {
    await fetch("/api/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    }).catch(() => {});
  }
};
