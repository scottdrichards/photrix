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

  return createPortal(
    <div className={css.backdrop} onClick={onClose}>
      <div className={css.sheet} onClick={(e) => e.stopPropagation()}>
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
