import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isAbort, logFailure } from "../logFailure";
import { attempt } from "../result";
import css from "./ShareLinkModal.module.css";

type Props = {
  url: string;
  copied: boolean;
  onClose: () => void;
};

/**
 * Feedback #156: the link is minted after two network round-trips, so the copy
 * done then can be refused, and an installed app has no browser menu to share
 * from. Both buttons here run from a fresh tap instead.
 */
const canNativeShare = () => typeof navigator.share === "function";

export const ShareLinkModal = ({ url, copied, onClose }: Props) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isCopied, setIsCopied] = useState(copied);

  const copyLink = async () => {
    // No async clipboard outside a secure context: leave the link selected.
    if (!navigator.clipboard) {
      inputRef.current?.select();
      return;
    }
    const result = await attempt(navigator.clipboard.writeText(url));
    if (result.ok) {
      setIsCopied(true);
      return;
    }
    logFailure("share.copy.failed", "Could not copy the share link")(result.error);
    inputRef.current?.select();
  };

  const shareLink = async () => {
    const result = await attempt(navigator.share({ url, title: document.title }));
    if (!result.ok && !isAbort(result.error)) {
      logFailure("share.native.failed", "The system share sheet failed")(result.error);
    }
  };

  // Select the full URL on open so Ctrl+C works immediately
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  // Close on Escape
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return createPortal(
    <div
      className={css.backdrop}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        className={css.sheet}
        role="dialog"
        aria-modal="true"
        aria-label="Share this view"
      >
        <div className={css.handle} />
        <h3 className={css.title}>Share this view</h3>

        <div className={css.urlRow}>
          <input
            ref={inputRef}
            className={css.urlInput}
            type="text"
            readOnly
            value={url}
            onFocus={(e) => e.currentTarget.select()}
            onClick={(e) => e.currentTarget.select()}
          />
        </div>

        <div className={css.actions}>
          {canNativeShare() && (
            <button className="btn btn-primary" onClick={() => void shareLink()}>
              Share…
            </button>
          )}
          <button className="btn btn-subtle" onClick={() => void copyLink()}>
            Copy link
          </button>
        </div>

        {isCopied && <p className={css.copiedNote}>Copied to clipboard</p>}

        <button className={`btn btn-subtle ${css.cancel}`} onClick={onClose}>
          Close
        </button>
      </div>
    </div>,
    document.body,
  );
};
