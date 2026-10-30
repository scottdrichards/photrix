import { useState } from "react";
import { isSharedView } from "../../hooks/useShareFilter";
import css from "./PeopleView.module.css";

const READ_ONLY = isSharedView();

type PersonTagEditorProps = {
  tags: string[];
  onSave: (tags: string[]) => void;
};

/**
 * Free-text tag chips for a person (feedback #78) — "Richards Family" etc.
 * Mirrors InlineNameEditor's edit-in-place pattern rather than a modal: type
 * a tag, Enter/comma commits it as a chip, click a chip's × to remove.
 * Read-only in a shared view, same guard as the name editor.
 */
export const PersonTagEditor = ({ tags, onSave }: PersonTagEditorProps) => {
  const [draft, setDraft] = useState("");

  if (READ_ONLY) {
    return tags.length > 0 ? (
      <div className={css.tagList}>
        {tags.map((tag) => (
          <span key={tag} className={css.tagChip}>
            {tag}
          </span>
        ))}
      </div>
    ) : null;
  }

  const commitDraft = () => {
    const trimmed = draft.trim();
    if (trimmed && !tags.includes(trimmed)) {
      onSave([...tags, trimmed]);
    }
    setDraft("");
  };

  const removeTag = (tag: string) => onSave(tags.filter((t) => t !== tag));

  return (
    <div className={css.tagList}>
      {tags.map((tag) => (
        <span key={tag} className={css.tagChip}>
          {tag}
          <button
            type="button"
            className={css.tagChipRemove}
            aria-label={`Remove tag ${tag}`}
            onClick={() => removeTag(tag)}
          >
            ✕
          </button>
        </span>
      ))}
      <input
        className={css.tagInput}
        value={draft}
        placeholder="Add tag…"
        onChange={(e) => {
          if (e.target.value.endsWith(",")) {
            setDraft(e.target.value.slice(0, -1));
            commitDraft();
            return;
          }
          setDraft(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commitDraft();
          }
        }}
        onBlur={commitDraft}
      />
    </div>
  );
};
