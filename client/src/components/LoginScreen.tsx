import { useEffect, useState } from "react";
import { isPasskeyAvailable, login, loginWithPasskey, registerPasskey } from "../auth";
import css from "./LoginScreen.module.css";

type Props = {
  onAuthenticated: () => void;
};

type Phase =
  | { type: "login" }
  | { type: "register-passkey"; username: string };

export const LoginScreen = ({ onAuthenticated }: Props) => {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [passkeyAvailable, setPasskeyAvailable] = useState(false);
  const [phase, setPhase] = useState<Phase>({ type: "login" });

  useEffect(() => {
    void isPasskeyAvailable().then(setPasskeyAvailable);
  }, []);

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const ok = await login(username, password);
      if (ok) {
        if (passkeyAvailable) {
          setPhase({ type: "register-passkey", username });
        } else {
          onAuthenticated();
        }
      } else {
        setError("Invalid username or password");
      }
    } catch {
      setError("Could not connect to server");
    } finally {
      setLoading(false);
    }
  };

  const handlePasskeyLogin = async () => {
    setError(null);
    setLoading(true);
    try {
      const ok = await loginWithPasskey();
      if (ok) {
        onAuthenticated();
      } else {
        setError("Passkey sign-in failed or was cancelled");
      }
    } catch {
      setError("Could not connect to server");
    } finally {
      setLoading(false);
    }
  };

  const handleRegisterPasskey = async () => {
    if (phase.type !== "register-passkey") return;
    setLoading(true);
    await registerPasskey(phase.username);
    setLoading(false);
    onAuthenticated();
  };

  if (phase.type === "register-passkey") {
    return (
      <div className={css.overlay}>
        <div className={css.card}>
          <h2 className={css.title}>Photrix</h2>
          <p className={css.subtitle}>Save a passkey for faster sign-in next time?</p>
          <div className={css.form}>
            <button
              className={css.button}
              onClick={() => void handleRegisterPasskey()}
              disabled={loading}
            >
              {loading ? "Saving…" : "Save passkey"}
            </button>
            <button
              className={css.buttonSecondary}
              onClick={onAuthenticated}
              disabled={loading}
            >
              Skip
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={css.overlay}>
      <div className={css.card}>
        <h2 className={css.title}>Photrix</h2>
        <p className={css.subtitle}>Sign in to continue</p>
        <form onSubmit={(e) => void handlePasswordSubmit(e)} className={css.form}>
          <input
            type="text"
            className={css.input}
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            autoComplete="username"
            disabled={loading}
          />
          <input
            type="password"
            className={css.input}
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            disabled={loading}
          />
          {error && <p className={css.error}>{error}</p>}
          <button type="submit" className={css.button} disabled={loading || !username || !password}>
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
        {passkeyAvailable && (
          <button
            className={css.buttonPasskey}
            onClick={() => void handlePasskeyLogin()}
            disabled={loading}
          >
            Sign in with passkey
          </button>
        )}
      </div>
    </div>
  );
};
