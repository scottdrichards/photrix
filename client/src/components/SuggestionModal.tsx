import { useEffect, useRef, useState } from "react";
import { fetchWithDiagnostics } from "../api/http";
import { flushClientDiagnostics, getClientSessionId } from "../diagnostics";
import css from "./SuggestionModal.module.css";

type Props = {
  onClose: () => void;
};

export const SuggestionModal = ({ onClose }: Props) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "sent" | "failed">("idle");

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
    if (!text.trim() || status === "submitting") return;
    setStatus("submitting");
    try {
      // The server saves this session's diagnostics with the suggestion, so make
      // sure the browser's latest events (e.g. the video that just froze) are there.
      await flushClientDiagnostics();
      const response = await fetchWithDiagnostics("/api/feedback", "send suggestion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, clientSessionId: getClientSessionId() }),
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      setStatus("sent");
      setTimeout(onClose, 1500);
    } catch {
      setStatus("failed");
    }
  };

  return (
    // Backdrop click-to-close; Escape is handled by onCancel below.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
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
            <p className={css.hint}>
              {status === "failed"
                ? "Couldn't send. Your text is still here; try again."
                : "Recent performance and error diagnostics from this browser are attached (no photo names or searches)."}
            </p>
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
