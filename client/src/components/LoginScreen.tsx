import { useState } from "react";
import { login } from "../auth";
import css from "./LoginScreen.module.css";

type Props = {
  onAuthenticated: () => void;
};

export const LoginScreen = ({ onAuthenticated }: Props) => {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const ok = await login(password);
      if (ok) {
        onAuthenticated();
      } else {
        setError("Incorrect password");
      }
    } catch {
      setError("Could not connect to server");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={css.overlay}>
      <div className={css.card}>
        <h2 className={css.title}>Photrix</h2>
        <p className={css.subtitle}>Enter password to continue</p>
        <form onSubmit={(e) => void handleSubmit(e)} className={css.form}>
          <input
            type="password"
            className={css.input}
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            disabled={loading}
          />
          {error && <p className={css.error}>{error}</p>}
          <button type="submit" className={css.button} disabled={loading || !password}>
            {loading ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
};
