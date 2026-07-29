import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import css from "./ShareLinkModal.module.css";

type Props = {
  url: string;
  copied: boolean;
  onClose: () => void;
};

export const ShareLinkModal = ({ url, copied, onClose }: Props) => {
  const inputRef = useRef<HTMLInputElement>(null);

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

        {copied && <p className={css.copiedNote}>Copied to clipboard</p>}

        <button className={`btn btn-subtle ${css.cancel}`} onClick={onClose}>
          Close
        </button>
      </div>
    </div>,
    document.body,
  );
};
