import {
  ChevronDown16Regular,
  ChevronUp16Regular,
  Dismiss12Regular,
  PersonSwap16Regular,
  Sparkle16Filled,
} from "@fluentui/react-icons";
import { useState } from "react";
import type {
  InterpretedFilterChip,
  InterpretedPersonAlternative,
} from "../../../../shared/filter-contract/src";
import css from "./SearchInterpretationChips.module.css";
import { readStorage, writeStorage } from "../../storage";

type Props = {
  /** The natural-language query these chips were derived from. */
  query: string;
  chips: InterpretedFilterChip[];
  /** People/places the query named that do not exist in this library. */
  ignored: string[];
  /**
   * Drop the chip's filter. Feedback #184: the words it was derived from go
   * back into the free-text search rather than disappearing.
   */
  onRemoveChip: (chip: InterpretedFilterChip) => void;
  /** Swap a person chip for one of the other people its typed name matched. */
  onSwapPerson?: (chip: InterpretedFilterChip, to: InterpretedPersonAlternative) => void;
  /** Restore the plain search: original query text, no derived filters. */
  onUndo: () => void;
};

// Feedback #182: the panel floats over the filter buttons, so it can be
// minimized to a small pill. The choice sticks across searches and reloads.
const MINIMIZED_KEY = "photrix_ai_search_minimized";

const readMinimized = (): boolean => readStorage(MINIMIZED_KEY) === "1";

const chipKey = (chip: InterpretedFilterChip) => `${chip.field}:${chip.value ?? chip.label}`;

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
  onSwapPerson,
  onUndo,
}: Props) => {
  const [pickingFor, setPickingFor] = useState<string | null>(null);
  const [minimized, setMinimized] = useState(readMinimized);
  if (chips.length === 0) return null;

  const toggleMinimized = () => {
    const next = !minimized;
    setMinimized(next);
    setPickingFor(null);
    writeStorage(MINIMIZED_KEY, next ? "1" : "0");
  };

  if (minimized) {
    return (
      <div
        className={`${css.bar} ${css.barMinimized}`}
        role="group"
        aria-label="AI-interpreted search filters"
      >
        <button
          type="button"
          className={css.minimizedToggle}
          onClick={toggleMinimized}
          aria-expanded={false}
          aria-label={`Show AI search filters (${chips.length})`}
          title={`Interpreted from “${query}”. Show the filters`}
        >
          <Sparkle16Filled className={css.badgeIcon} />
          AI search · {chips.length}
          <ChevronDown16Regular />
        </button>
      </div>
    );
  }
  const picking = chips.find(
    (chip) => chipKey(chip) === pickingFor && (chip.alternatives?.length ?? 0) > 0,
  );

  return (
    <div className={css.bar} role="group" aria-label="AI-interpreted search filters">
      <span className={css.badge} title={`Interpreted from “${query}”`}>
        <Sparkle16Filled className={css.badgeIcon} />
        AI search
      </span>

      <div className={css.chips}>
        {chips.map((chip) => (
          <span key={chipKey(chip)} className={css.chip}>
            {chip.label}
            {onSwapPerson && (chip.alternatives?.length ?? 0) > 0 && (
              <button
                type="button"
                className={css.chipRemove}
                onClick={() =>
                  setPickingFor((current) => (current === chipKey(chip) ? null : chipKey(chip)))
                }
                aria-label={`Pick a different person than ${chip.label}`}
                aria-expanded={pickingFor === chipKey(chip)}
                title="Pick a different person"
              >
                <PersonSwap16Regular />
              </button>
            )}
            <button
              type="button"
              className={css.chipRemove}
              onClick={() => onRemoveChip(chip)}
              aria-label={`Remove filter ${chip.label}`}
              title={
                chip.field === "semanticQuery"
                  ? "Remove"
                  : "Remove this filter and search its words as text"
              }
            >
              <Dismiss12Regular />
            </button>
          </span>
        ))}
      </div>

      {picking && onSwapPerson && (
        <div
          className={css.alternatives}
          role="group"
          aria-label={`People to search instead of ${picking.label}`}
        >
          <span className={css.alternativesLabel}>Instead of {picking.label}:</span>
          {picking.alternatives?.map((alternative) => (
            <button
              key={`${alternative.field}:${alternative.value}`}
              type="button"
              className={css.alternative}
              onClick={() => {
                setPickingFor(null);
                onSwapPerson(picking, alternative);
              }}
            >
              {alternative.label}
            </button>
          ))}
        </div>
      )}

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
      <button
        type="button"
        className={css.chipRemove}
        onClick={toggleMinimized}
        aria-expanded
        aria-label="Minimize AI search filters"
        title="Minimize"
      >
        <ChevronUp16Regular />
      </button>
    </div>
  );
};
