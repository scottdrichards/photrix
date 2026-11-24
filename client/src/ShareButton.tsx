import { Share24Regular } from "@fluentui/react-icons";
import { useState } from "react";
import css from "./App.module.css";
import { buildShareScope, fetchShareScopeCount, LARGE_SHARE_THRESHOLD } from "./api";
import { LargeShareWarningModal } from "./components/share/LargeShareWarningModal";
import { ShareLinkModal } from "./components/share/ShareLinkModal";
import { useFilter } from "./components/filter/FilterContext";
import { getAuthHeaders } from "./auth";
import { copyToClipboard } from "./copyToClipboard";
import { buildShareUrl } from "./hooks/useShareFilter";
import { logFailure } from "./logFailure";
import { attempt } from "./result";

type ShareModalState = { url: string; copied: boolean } | null;

const SHARE_FAILED_MESSAGE_MS = 4_000;

export const ShareButton = () => {
  const { filter } = useFilter();
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [modal, setModal] = useState<ShareModalState>(null);
  // A share whose size crossed the threshold and is waiting on confirmation.
  const [pendingLarge, setPendingLarge] = useState<{
    scope: unknown;
    /** Null when the size couldn't be measured. */
    count: number | null;
    wholeLibrary: boolean;
  } | null>(null);

  const mintAndShow = async (shareScope: unknown) => {
    const res = await fetch("/api/auth/share-token", {
      method: "POST",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(shareScope),
    });
    if (!res.ok) throw new Error("Failed to issue share token");
    const { token } = (await res.json()) as { token: string };
    const url = buildShareUrl(token);
    const copied = await copyToClipboard(url);
    setModal({ url, copied });
  };

  const shareScope = buildShareScope({
    ...filter,
    path: filter.path,
    includeSubfolders: filter.includeSubfolders,
  });
  // Feedback #187: a view with no filter shares the whole library. That is
  // allowed, but always behind the large-share warning, and the server only
  // accepts it when the scope says so by name.
  const isUnscoped =
    !shareScope.semanticQuery &&
    typeof shareScope.filter === "object" &&
    shareScope.filter !== null &&
    Object.keys(shareScope.filter).length === 0;

  const handleShare = async () => {
    if (loading) return;
    setLoading(true);
    try {

      // Size the share before minting. A failure here must not block sharing —
      // the count is a guardrail, not a gate — so fall through to the normal
      // path if it can't be determined.
      const scope = isUnscoped ? { ...shareScope, wholeLibrary: true } : shareScope;
      const counted = await attempt(fetchShareScopeCount(scope));
      if (!counted.ok) {
        logFailure("share.count.failed", "Could not size the share; sharing without the large-share check")(
          counted.error,
        );
      }

      if (isUnscoped) {
        setPendingLarge({
          scope,
          count: counted.ok ? counted.value : null,
          wholeLibrary: true,
        });
        return;
      }
      if (counted.ok && counted.value > LARGE_SHARE_THRESHOLD) {
        setPendingLarge({ scope: shareScope, count: counted.value, wholeLibrary: false });
        return;
      }

      await mint(scope);
    } finally {
      setLoading(false);
    }
  };

  // Mints the link, or says on the button that it couldn't.
  const mint = async (scope: unknown) => {
    const minted = await attempt(mintAndShow(scope));
    if (minted.ok) return;
    logFailure("share.mint.failed", "Could not create a share link")(minted.error);
    setFailed(true);
    setTimeout(() => setFailed(false), SHARE_FAILED_MESSAGE_MS);
  };

  const confirmLarge = async () => {
    if (!pendingLarge) return;
    const { scope } = pendingLarge;
    setPendingLarge(null);
    setLoading(true);
    await mint(scope);
    setLoading(false);
  };

  return (
    <>
      <button
        title={isUnscoped ? "Share your whole library" : "Share current view"}
        className="btn btn-subtle"
        onClick={() => void handleShare()}
        disabled={loading}
      >
        <Share24Regular fontSize={20} />
        <span className={css.btnLabel} role="status">
          {loading ? "Sharing…" : failed ? "Couldn't share" : "Share"}
        </span>
      </button>

      {pendingLarge && (
        <LargeShareWarningModal
          count={pendingLarge.count}
          wholeLibrary={pendingLarge.wholeLibrary}
          onConfirm={() => void confirmLarge()}
          onCancel={() => setPendingLarge(null)}
        />
      )}

      {modal && (
        <ShareLinkModal
          url={modal.url}
          copied={modal.copied}
          onClose={() => setModal(null)}
        />
      )}
    </>
  );
};
