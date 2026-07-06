const TOKEN_KEY = "photrix_auth_token";

export const getToken = (): string | null => localStorage.getItem(TOKEN_KEY);
export const setToken = (token: string) => localStorage.setItem(TOKEN_KEY, token);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

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
  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get("token");
  if (urlToken) setToken(urlToken);
};

// Returns true if authenticated or auth is not required, false if login needed.
export const initAuth = async (): Promise<boolean> => {
  const token = getToken();
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
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

export const login = async (password: string): Promise<boolean> => {
  const response = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!response.ok) return false;
  const data = (await response.json()) as { token?: string };
  if (!data.token) return false;
  setToken(data.token);
  return true;
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
