import { useCallback, useEffect, useRef, useState } from "react";
import {
  createMcpKey,
  fetchAccount,
  fetchMcpKeys,
  fetchPasskeys,
  fetchSessions,
  fetchShareLinks,
  removePasskey,
  revokeAllSessions,
  revokeMcpKey,
  revokeSession,
  revokeShareLink,
  type McpKey,
  type NewMcpKey,
  type Passkey,
  type Session,
  type ShareLink,
} from "../api/account";
import { clearToken, isPasskeyAvailable, registerPasskey } from "../auth";
import { buildShareUrl } from "../hooks/useShareFilter";
import css from "./AccountPanel.module.css";

type Props = {
  isOpen: boolean;
  onDismiss: () => void;
};

const formatDate = (ms: number): string =>
  new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

const copyToClipboard = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};

const syncDialogOpenState = (dialog: HTMLDialogElement, isOpen: boolean) => {
  try {
    if (isOpen) {
      if (!dialog.open) dialog.showModal();
      return;
    }
    if (dialog.open) dialog.close();
  } catch {
    // Ignore dialog state races so the panel never crashes the app.
  }
};

const mcpConfigSnippet = (token: string): string => {
  const host = typeof window !== "undefined" ? window.location.hostname : "your-server";
  return JSON.stringify(
    {
      mcpServers: {
        photrix: {
          type: "http",
          url: `http://${host}:3100/mcp`,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  );
};

export const AccountPanel = ({ isOpen, onDismiss }: Props) => {
  const dialogRef = useRef<HTMLDialogElement>(null);

  const [username, setUsername] = useState<string | null>(null);
  const [mcpKeys, setMcpKeys] = useState<McpKey[]>([]);
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [shareLinks, setShareLinks] = useState<ShareLink[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [passkeySupported, setPasskeySupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [newKeyName, setNewKeyName] = useState("");
  const [revealedKey, setRevealedKey] = useState<NewMcpKey | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog) syncDialogOpenState(dialog, isOpen);
  }, [isOpen]);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [account, keys, pks, links, sess] = await Promise.all([
        fetchAccount(),
        fetchMcpKeys(),
        fetchPasskeys(),
        fetchShareLinks(),
        fetchSessions(),
      ]);
      setUsername(account.username);
      setMcpKeys(keys);
      setPasskeys(pks);
      setShareLinks(links);
      setSessions(sess);
    } catch {
      setError("Could not load account details.");
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    setRevealedKey(null);
    setNewKeyName("");
    void isPasskeyAvailable().then(setPasskeySupported);
    void reload();
  }, [isOpen, reload]);

  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const handleGenerateKey = () =>
    run(async () => {
      const key = await createMcpKey(newKeyName.trim() || "MCP key");
      setRevealedKey(key);
      setNewKeyName("");
      await reload();
    });

  const handleCopy = async (value: string, tag: string) => {
    if (await copyToClipboard(value)) {
      setCopied(tag);
      setTimeout(() => setCopied((c) => (c === tag ? null : c)), 2000);
    }
  };

  const handleAddPasskey = () =>
    run(async () => {
      if (!username) return;
      const ok = await registerPasskey(username);
      if (!ok) throw new Error("passkey registration failed");
      await reload();
    });

  const handleSignOutEverywhere = () =>
    run(async () => {
      await revokeAllSessions();
      clearToken();
      window.location.reload();
    });

  return (
    <dialog
      ref={dialogRef}
      onClose={onDismiss}
      onClick={(e) => {
        // Native <dialog> click-outside-to-close: a click that lands on the
        // dialog element itself (not a child) hit the backdrop/padding
        // area, matching the pattern used in SuggestionModal.tsx.
        if (e.target === e.currentTarget) onDismiss();
      }}
      className={css.dialog}
    >
      <div className={css.body}>
        <header className={css.head}>
          <h2 className={css.title}>Account</h2>
          {username && <p className={css.subtitle}>Signed in as {username}</p>}
        </header>

        {error && <p className={css.error}>{error}</p>}

        {/* --- MCP keys --- */}
        <section className={css.section}>
          <h3 className={css.sectionTitle}>MCP keys</h3>
          <p className={css.hint}>
            Give an AI agent (Claude Desktop / Code) read access to your library.
          </p>

          {revealedKey && (
            <div className={css.reveal}>
              <p className={css.revealNote}>
                Copy this key now — it won&apos;t be shown again.
              </p>
              <div className={css.tokenRow}>
                <code className={css.token}>{revealedKey.token}</code>
                <button
                  className="btn btn-subtle"
                  onClick={() => void handleCopy(revealedKey.token, "token")}
                >
                  {copied === "token" ? "Copied" : "Copy"}
                </button>
              </div>
              <details className={css.details}>
                <summary>MCP client config</summary>
                <pre className={css.snippet}>{mcpConfigSnippet(revealedKey.token)}</pre>
                <button
                  className="btn btn-subtle"
                  onClick={() =>
                    void handleCopy(mcpConfigSnippet(revealedKey.token), "config")
                  }
                >
                  {copied === "config" ? "Copied" : "Copy config"}
                </button>
              </details>
            </div>
          )}

          <div className={css.createRow}>
            <input
              className={css.input}
              placeholder="Key name (e.g. Claude Desktop)"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              disabled={busy}
            />
            <button
              className="btn btn-primary"
              onClick={() => void handleGenerateKey()}
              disabled={busy}
            >
              Generate
            </button>
          </div>

          {mcpKeys.length === 0 ? (
            <p className={css.empty}>No MCP keys yet.</p>
          ) : (
            <ul className={css.list}>
              {mcpKeys.map((key) => (
                <li key={key.id} className={css.row}>
                  <div className={css.rowMain}>
                    <span className={css.rowName}>{key.name}</span>
                    <span className={css.rowMeta}>
                      Created {formatDate(key.createdAt)} ·{" "}
                      {key.lastUsedAt
                        ? `last used ${formatDate(key.lastUsedAt)}`
                        : "never used"}
                    </span>
                  </div>
                  <button
                    className="btn btn-subtle"
                    onClick={() => void run(() => revokeMcpKey(key.id).then(reload))}
                    disabled={busy}
                  >
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* --- Passkeys --- */}
        <section className={css.section}>
          <h3 className={css.sectionTitle}>Passkeys</h3>
          <p className={css.hint}>Sign in without a password using this device.</p>
          {passkeys.length === 0 ? (
            <p className={css.empty}>No passkeys registered.</p>
          ) : (
            <ul className={css.list}>
              {passkeys.map((pk) => (
                <li key={pk.credentialId} className={css.row}>
                  <div className={css.rowMain}>
                    <span className={css.rowName}>{pk.name || "Passkey"}</span>
                    <span className={css.rowMeta}>Added {formatDate(pk.createdAt)}</span>
                  </div>
                  <button
                    className="btn btn-subtle"
                    onClick={() =>
                      void run(() => removePasskey(pk.credentialId).then(reload))
                    }
                    disabled={busy}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          {passkeySupported && (
            <button
              className="btn btn-subtle"
              onClick={() => void handleAddPasskey()}
              disabled={busy}
            >
              Add a passkey
            </button>
          )}
        </section>

        {/* --- Share links --- */}
        <section className={css.section}>
          <h3 className={css.sectionTitle}>Share links</h3>
          <p className={css.hint}>
            Read-only links to a filtered view. Create them with the Share button.
          </p>
          {shareLinks.length === 0 ? (
            <p className={css.empty}>No share links yet.</p>
          ) : (
            <ul className={css.list}>
              {shareLinks.map((link) => (
                <li key={link.token} className={css.row}>
                  <div className={css.rowMain}>
                    <span className={css.rowName}>
                      {link.label}
                      {link.revokedAt && <span className={css.badge}>Revoked</span>}
                    </span>
                    <span className={css.rowMeta}>Created {formatDate(link.createdAt)}</span>
                  </div>
                  {!link.revokedAt && (
                    <div className={css.rowActions}>
                      <button
                        className="btn btn-subtle"
                        onClick={() =>
                          void handleCopy(buildShareUrl(link.token), `link-${link.token}`)
                        }
                      >
                        {copied === `link-${link.token}` ? "Copied" : "Copy"}
                      </button>
                      <button
                        className="btn btn-subtle"
                        onClick={() =>
                          void run(() => revokeShareLink(link.token).then(reload))
                        }
                        disabled={busy}
                      >
                        Revoke
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* --- Sessions --- */}
        <section className={css.section}>
          <h3 className={css.sectionTitle}>Active sessions</h3>
          {sessions.length === 0 ? (
            <p className={css.empty}>No active sessions.</p>
          ) : (
            <ul className={css.list}>
              {sessions.map((s) => (
                <li key={s.id} className={css.row}>
                  <div className={css.rowMain}>
                    <span className={css.rowName}>
                      {s.current ? "This device" : "Session"}
                      {s.current && <span className={css.badge}>Current</span>}
                    </span>
                    <span className={css.rowMeta}>
                      Signed in {formatDate(s.createdAt)}
                    </span>
                  </div>
                  {!s.current && (
                    <button
                      className="btn btn-subtle"
                      onClick={() => void run(() => revokeSession(s.id).then(reload))}
                      disabled={busy}
                    >
                      Revoke
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <button
            className={`btn btn-subtle ${css.danger}`}
            onClick={() => void handleSignOutEverywhere()}
            disabled={busy}
          >
            Sign out everywhere
          </button>
        </section>

        <div className={css.actions}>
          <button className="btn btn-primary" onClick={onDismiss}>
            Done
          </button>
        </div>
      </div>
    </dialog>
  );
};
