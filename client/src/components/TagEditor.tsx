import { useState } from "react";
import { Add16Regular, Dismiss12Regular } from "@fluentui/react-icons";
import css from "./TagEditor.module.css";

type TagEditorProps = {
  tags: string[];
  /** Called with the full next tag list whenever a tag is added or removed. */
  onChange: (tags: string[]) => void;
  placeholder?: string;
  className?: string;
};

const normalize = (raw: string): string => raw.trim();

export function TagEditor({
  tags,
  onChange,
  placeholder = "Add label…",
  className,
}: TagEditorProps) {
  const [draft, setDraft] = useState("");

  const commitDraft = () => {
    const value = normalize(draft);
    setDraft("");
    if (!value) return;
    // Case-insensitive dedupe against the existing labels.
    if (tags.some((t) => t.toLowerCase() === value.toLowerCase())) return;
    onChange([...tags, value]);
  };

  const removeTag = (tag: string) => {
    onChange(tags.filter((t) => t !== tag));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commitDraft();
      return;
    }
    // Backspace on an empty draft removes the last chip.
    if (e.key === "Backspace" && draft === "" && tags.length > 0) {
      e.preventDefault();
      removeTag(tags[tags.length - 1]);
    }
  };

  return (
    <div className={className ? `${css.editor} ${className}` : css.editor}>
      {tags.map((tag) => (
        <span key={tag} className={css.chip}>
          <span className={css.chipLabel}>{tag}</span>
          <button
            type="button"
            className={css.chipRemove}
            onClick={() => removeTag(tag)}
            aria-label={`Remove label ${tag}`}
            title={`Remove ${tag}`}
          >
            <Dismiss12Regular />
          </button>
        </span>
      ))}
      <span className={css.inputWrap}>
        <input
          type="text"
          className={css.input}
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={commitDraft}
          aria-label="Add label"
        />
        {draft.trim() && (
          <button
            type="button"
            className={css.addButton}
            onMouseDown={(e) => {
              // Fire before the input's blur so the draft is still present.
              e.preventDefault();
              commitDraft();
            }}
            aria-label="Add label"
            title="Add label"
          >
            <Add16Regular />
          </button>
        )}
      </span>
    </div>
  );
}
