import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { Spinner } from "../Spinner";
import css from "./AuthGate.module.css";
import {
  getAuthSession,
  loginWithPasskey,
  registerWithPasskey,
  signOut,
} from "./authApi";

type AuthGateProps = {
  children: ReactNode;
};

type AuthState = {
  loading: boolean;
  authenticated: boolean;
  setupRequired: boolean;
  username: string;
};

type AuthContextValue = {
  username: string;
  isSigningOut: boolean;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

const initialState: AuthState = {
  loading: true,
  authenticated: false,
  setupRequired: false,
  username: "",
};

export const AuthGate = ({ children }: AuthGateProps) => {
  const [state, setState] = useState(initialState);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [usernameInput, setUsernameInput] = useState("");
  const [bootstrapTokenInput, setBootstrapTokenInput] = useState("");

  const refreshSession = async () => {
    const session = await getAuthSession();
    setState({
      loading: false,
      authenticated: !session.authEnabled || session.authenticated,
      setupRequired: session.setupRequired,
      username: session.username ?? (!session.authEnabled ? "auth-disabled" : ""),
    });
  };

  useEffect(() => {
    refreshSession().catch((refreshError) => {
      setState((current) => ({ ...current, loading: false }));
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    });
  }, []);

  const handleRegister = async () => {
    setBusy(true);
    setError("");

    try {
      await registerWithPasskey(usernameInput.trim(), bootstrapTokenInput.trim());
      await refreshSession();
    } catch (registerError) {
      setError(registerError instanceof Error ? registerError.message : String(registerError));
    } finally {
      setBusy(false);
    }
  };

  const handleLogin = async () => {
    setBusy(true);
    setError("");

    try {
      const username = usernameInput.trim();
      await loginWithPasskey(username ? username : undefined);
      await refreshSession();
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : String(loginError));
    } finally {
      setBusy(false);
    }
  };

  const handleSignOut = async () => {
    setBusy(true);
    setError("");

    try {
      await signOut();
      await refreshSession();
    } catch (signOutError) {
      setError(signOutError instanceof Error ? signOutError.message : String(signOutError));
    } finally {
      setBusy(false);
    }
  };

  if (state.loading) {
    return (
      <div className={css.root}>
        <Spinner label="Checking session…" />
      </div>
    );
  }

  if (state.authenticated) {
    return (
      <AuthContext.Provider
        value={{ username: state.username, isSigningOut: busy, signOut: handleSignOut }}
      >
        {children}
      </AuthContext.Provider>
    );
  }

  const hasUsernameInput = usernameInput.trim().length > 0;
  const canRegister =
    state.setupRequired && hasUsernameInput && bootstrapTokenInput.trim().length > 0 && !busy;
  const canLogin = !state.setupRequired && !busy;

  return (
    <div className={css.root}>
      <div className={css.card}>
        <div>
          <h3>{state.setupRequired ? "Set up Photrix" : "Sign in to Photrix"}</h3>
          <p>
            {state.setupRequired
              ? "Create the first admin user with a passkey."
              : "Use your passkey to unlock the application."}
          </p>
        </div>

        <div className={css.content}>
          <input
            className="input"
            value={usernameInput}
            onChange={(e) => setUsernameInput(e.target.value)}
            placeholder="Username"
            disabled={busy}
          />

          {state.setupRequired ? (
            <input
              className="input"
              value={bootstrapTokenInput}
              onChange={(e) => setBootstrapTokenInput(e.target.value)}
              placeholder="Bootstrap token"
              type="password"
              disabled={busy}
            />
          ) : null}

          <button
            className="btn btn-primary"
            onClick={state.setupRequired ? handleRegister : handleLogin}
            disabled={state.setupRequired ? !canRegister : !canLogin}
          >
            {busy ? "Working…" : state.setupRequired ? "Create passkey" : "Sign in with passkey"}
          </button>

          {error ? <span>{error}</span> : null}
        </div>
      </div>
    </div>
  );
};

export const useAuthSession = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuthSession must be used within AuthGate");
  }

  return context;
};
