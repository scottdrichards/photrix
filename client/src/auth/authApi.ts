import { startAuthentication, startRegistration } from "@simplewebauthn/browser";

type AuthSession = {
  authEnabled: boolean;
  setupRequired: boolean;
  authenticated: boolean;
  username: string | null;
};

type JsonOptions = {
  method?: "GET" | "POST";
  body?: Record<string, unknown>;
};

const fetchJson = async <T>(path: string, options: JsonOptions = {}) => {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    credentials: "same-origin",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Auth request failed: ${response.status}`);
  }

  return (await response.json()) as T;
};

export const getAuthSession = async () => {
  return fetchJson<AuthSession>("/api/auth/session");
};

export const signOut = async () => {
  await fetchJson<{ ok: boolean }>("/api/auth/logout", { method: "POST" });
};

export const registerWithPasskey = async (username: string, bootstrapToken: string) => {
  const options = await fetchJson<Parameters<typeof startRegistration>[0]["optionsJSON"]>(
    "/api/auth/register/options",
    {
    method: "POST",
    body: { username, bootstrapToken },
    },
  );

  const registrationResponse = await startRegistration({ optionsJSON: options });

  await fetchJson<{ ok: boolean; username: string }>("/api/auth/register/verify", {
    method: "POST",
    body: {
      username,
      response: registrationResponse,
    },
  });
};

export const loginWithPasskey = async (username?: string) => {
  const payload = await fetchJson<{
    username: string;
    options: Parameters<typeof startAuthentication>[0]["optionsJSON"];
  }>(
    "/api/auth/login/options",
    {
      method: "POST",
      body: username ? { username } : {},
    },
  );

  const authenticationResponse = await startAuthentication({
    optionsJSON: payload.options,
  });

  await fetchJson<{ ok: boolean; username: string }>("/api/auth/login/verify", {
    method: "POST",
    body: {
      username: payload.username,
      response: authenticationResponse,
    },
  });
};
