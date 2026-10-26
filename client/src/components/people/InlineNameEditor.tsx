import { useRef, useState } from "react";
import { isSharedView } from "../../hooks/useShareFilter";
import css from "../PeopleView.module.css";

const READ_ONLY = isSharedView();

type InlineNameEditorProps = {
  name: string | null;
  onSave: (name: string | null) => void;
};

export const InlineNameEditor = ({ name, onSave }: InlineNameEditorProps) => {
  // In a shared view names are display-only; render as static text with no
  // affordance to edit. Unnamed clusters show nothing rather than "Add name…".
  // Returns before any hooks so hook order stays stable (READ_ONLY is constant).
  if (READ_ONLY) {
    return name ? <span className={css.clusterName}>{name}</span> : null;
  }

  return <InlineNameEditorControl name={name} onSave={onSave} />;
};

const InlineNameEditorControl = ({ name, onSave }: InlineNameEditorProps) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDraft(name ?? "");
    setEditing(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const commit = (e: React.MouseEvent | React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const trimmed = draft.trim();
    onSave(trimmed || null);
    setEditing(false);
  };

  const cancel = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    setEditing(false);
  };

  if (editing) {
    return (
      <form className={css.nameForm} onSubmit={commit}>
        <input
          ref={inputRef}
          className={css.nameInput}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Enter name…"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Escape") cancel(e);
          }}
        />
        <button
          type="submit"
          className={css.nameSaveBtn}
          onClick={(e) => e.stopPropagation()}
        >
          ✓
        </button>
        <button type="button" className={css.nameCancelBtn} onClick={cancel}>
          ✕
        </button>
      </form>
    );
  }

  return (
    <button
      type="button"
      className={name ? css.clusterName : css.clusterNameEmpty}
      onClick={startEdit}
      title="Click to set name"
    >
      {name ?? "Add name…"}
    </button>
  );
};
