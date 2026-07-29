import { useEffect, useRef, useState } from "react";
import { getAuthHeaders } from "../auth";
import css from "./SuggestionModal.module.css";

type Props = {
  onClose: () => void;
};

export const SuggestionModal = ({ onClose }: Props) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "sent">("idle");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    textareaRef.current?.focus();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  const submit = async () => {
    if (!text.trim() || status !== "idle") return;
    setStatus("submitting");
    try {
      await fetch("/api/feedback", {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      setStatus("sent");
      setTimeout(onClose, 1500);
    } catch {
      setStatus("idle");
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className={css.dialog}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      aria-label="Send a suggestion"
    >
      <div className={css.content}>
        <h3 className={css.title}>Send a suggestion</h3>
        {status === "sent" ? (
          <p className={css.sent}>Thanks! Suggestion saved.</p>
        ) : (
          <>
            <textarea
              ref={textareaRef}
              className={css.textarea}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="What could be better?"
              rows={4}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
            <div className={css.actions}>
              <button className="btn btn-subtle" onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void submit()}
                disabled={!text.trim() || status === "submitting"}
              >
                {status === "submitting" ? "Sending…" : "Send"}
              </button>
            </div>
          </>
        )}
      </div>
    </dialog>
  );
};
