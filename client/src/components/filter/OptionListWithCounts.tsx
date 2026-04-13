import { useMemo } from "react";
import css from "./OptionListWithCounts.module.css";

type OptionListWithCountsProps = {
    options: {
    key: string;
    label: string;
    count: number;
    selected?: boolean;
  }[];
  onSelect: (optionKey: string) => void;
};

export const OptionListWithCounts = ({ options, onSelect }: OptionListWithCountsProps) => {
  const formatNumber = useMemo(() => new Intl.NumberFormat(), []);

  if (options.length === 0) {
    return null;
  }

  return (
    <div className={css.list}>
      {options.map((option) => (
        <button
          key={option.key}
          className={`btn btn-sm ${css.button} ${option.selected ? "btn-primary" : "btn-subtle"}`}
          onClick={() => onSelect(option.key)}
        >
          <span>{option.label}</span>
          <span className={css.countText}>{` (${formatNumber.format(option.count)})`}</span>
        </button>
      ))}
    </div>
  );
};
