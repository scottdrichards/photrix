import { useState } from "react";
import css from "./DescriptionEditor.module.css";

type DescriptionEditorProps = {
  /** Current saved description; empty string when unset. */
  value: string;
  /** Called with the trimmed next value on blur, only when it actually changed. */
  onSave: (value: string) => void;
  placeholder?: string;
};

/**
 * Freeform per-photo caption editor. Mirrors TagEditor's save-on-blur pattern:
 * types into a local draft, commits on blur, and is a no-op if nothing changed.
 * Callers should key this on the photo path so switching photos remounts it
 * with a fresh draft instead of leaking the previous photo's in-progress edit.
 */
export function DescriptionEditor({
  value,
  onSave,
  placeholder = "Add a description…",
}: DescriptionEditorProps) {
  const [draft, setDraft] = useState(value);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === value.trim()) return;
    setDraft(trimmed);
    onSave(trimmed);
  };

  return (
    <textarea
      className={css.textarea}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      aria-label="Description"
      rows={3}
    />
  );
}
