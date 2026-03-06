import {
  Body1,
  Button,
  Card,
  CardHeader,
  Input,
  Spinner,
  Text,
  Title3,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import {
  getAuthSession,
  loginWithPasskey,
  registerWithPasskey,
  signOut,
} from "./authApi";

const useStyles = makeStyles({
  root: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: tokens.spacingHorizontalL,
  },
  stack: {
    width: "100%",
    maxWidth: "440px",
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingHorizontalM,
  },
  content: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingHorizontalM,
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
  },
});

type AuthGateProps = {
  children: ReactNode;
};

type AuthState = {
  loading: boolean;
  authenticated: boolean;
  setupRequired: boolean;
  username: string;
};

const initialState: AuthState = {
  loading: true,
  authenticated: false,
  setupRequired: false,
  username: "",
};

export const AuthGate = ({ children }: AuthGateProps) => {
  const styles = useStyles();
  const [state, setState] = useState(initialState);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [usernameInput, setUsernameInput] = useState("");
  const [bootstrapTokenInput, setBootstrapTokenInput] = useState("");

  const refreshSession = async () => {
    const session = await getAuthSession();
    setState({
      loading: false,
      authenticated: session.authenticated,
      setupRequired: session.setupRequired,
      username: session.username ?? "",
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
      <div className={styles.root}>
        <Spinner label="Checking session…" />
      </div>
    );
  }

  if (state.authenticated) {
    return (
      <>
        <div className={styles.root} style={{ minHeight: "auto", justifyContent: "flex-end" }}>
          <div className={styles.actions}>
            <Text>Signed in as {state.username}</Text>
            <Button appearance="subtle" onClick={handleSignOut} disabled={busy}>
              Sign out
            </Button>
          </div>
        </div>
        {children}
      </>
    );
  }

  const hasUsernameInput = usernameInput.trim().length > 0;
  const canRegister =
    state.setupRequired && hasUsernameInput && bootstrapTokenInput.trim().length > 0 && !busy;
  const canLogin = !state.setupRequired && !busy;

  return (
    <div className={styles.root}>
      <Card className={styles.stack}>
        <CardHeader
          header={<Title3>{state.setupRequired ? "Set up Photrix" : "Sign in to Photrix"}</Title3>}
          description={
            <Body1>
              {state.setupRequired
                ? "Create the first admin user with a passkey."
                : "Use your passkey to unlock the application."}
            </Body1>
          }
        />

        <div className={styles.content}>
          <Input
            value={usernameInput}
            onChange={(_, data) => setUsernameInput(data.value)}
            placeholder="Username"
            disabled={busy}
          />

          {state.setupRequired ? (
            <Input
              value={bootstrapTokenInput}
              onChange={(_, data) => setBootstrapTokenInput(data.value)}
              placeholder="Bootstrap token"
              type="password"
              disabled={busy}
            />
          ) : null}

          <Button
            appearance="primary"
            onClick={state.setupRequired ? handleRegister : handleLogin}
            disabled={state.setupRequired ? !canRegister : !canLogin}
          >
            {busy ? "Working…" : state.setupRequired ? "Create passkey" : "Sign in with passkey"}
          </Button>

          {error ? <Text>{error}</Text> : null}
        </div>
      </Card>
    </div>
  );
};
