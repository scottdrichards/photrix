import { Dismiss12Regular, Sparkle16Filled } from "@fluentui/react-icons";
import type { InterpretedFilterChip } from "../../../shared/filter-contract/src";
import css from "./SearchInterpretationChips.module.css";

type Props = {
  /** The natural-language query these chips were derived from. */
  query: string;
  chips: InterpretedFilterChip[];
  /** People/places the query named that do not exist in this library. */
  ignored: string[];
  onRemoveChip: (chip: InterpretedFilterChip) => void;
  /** Restore the plain search: original query text, no derived filters. */
  onUndo: () => void;
};

/**
 * The visible, undoable form of an AI-interpreted query.
 *
 * Every filter the model derived is shown as an ordinary removable chip, so the
 * interpretation is never something that silently happened to the results — the
 * user can see exactly which constraints were added, drop any of them
 * individually, or undo the whole thing back to a plain search.
 */
export const SearchInterpretationChips = ({
  query,
  chips,
  ignored,
  onRemoveChip,
  onUndo,
}: Props) => {
  if (chips.length === 0) return null;

  return (
    <div className={css.bar} role="group" aria-label="AI-interpreted search filters">
      <span className={css.badge} title={`Interpreted from “${query}”`}>
        <Sparkle16Filled className={css.badgeIcon} />
        AI search
      </span>

      <div className={css.chips}>
        {chips.map((chip) => (
          <span key={`${chip.field}:${chip.value ?? chip.label}`} className={css.chip}>
            {chip.label}
            <button
              type="button"
              className={css.chipRemove}
              onClick={() => onRemoveChip(chip)}
              aria-label={`Remove filter ${chip.label}`}
            >
              <Dismiss12Regular />
            </button>
          </span>
        ))}
      </div>

      {ignored.length > 0 && (
        <span
          className={css.ignored}
          title="Not found in your library, so not filtered on"
        >
          ignored: {ignored.join(", ")}
        </span>
      )}

      <button type="button" className={css.undo} onClick={onUndo}>
        Undo
      </button>
    </div>
  );
};
