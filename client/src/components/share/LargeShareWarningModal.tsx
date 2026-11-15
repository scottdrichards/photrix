import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import css from "./LargeShareWarningModal.module.css";

type Props = {
  /** How many items the pending share would grant access to; null if unknown. */
  count: number | null;
  /** No filter at all: the link covers everything in the library. */
  wholeLibrary?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Confirmation step for an unusually broad share link.
 *
 * The Share button captures the *current view*, so an unfiltered view mints a
 * link to the entire library — valid, but rarely what someone means to hand
 * out. This makes the size of the grant explicit before the link exists.
 */
export const LargeShareWarningModal = ({
  count,
  wholeLibrary = false,
  onConfirm,
  onCancel,
}: Props) => {
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Focus the safe choice, so a stray Enter cancels rather than shares.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return createPortal(
    <div
      className={css.backdrop}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      role="presentation"
    >
      <div
        className={css.sheet}
        role="alertdialog"
        aria-modal="true"
        aria-label="Confirm large share"
      >
        <div className={css.handle} />
        <h3 className={css.title}>This is a large share, are you sure?</h3>
        <p className={css.body}>
          {wholeLibrary ? (
            <>
              Nothing is filtered, so this link will give anyone who opens it access to{" "}
              <span className={css.count}>
                your whole library
                {count !== null ? ` (${count.toLocaleString()} items)` : ""}
              </span>
              .
            </>
          ) : (
            <>
              This link will give anyone who opens it access to{" "}
              <span className={css.count}>
                {count !== null ? `${count.toLocaleString()} items` : "an unknown number of items"}
              </span>
              .
            </>
          )}
        </p>
        <div className={css.actions}>
          <button ref={cancelRef} className="btn btn-subtle" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn" onClick={onConfirm}>
            Share anyway
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
