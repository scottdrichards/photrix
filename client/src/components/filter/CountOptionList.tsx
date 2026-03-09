import { Button, makeStyles, tokens } from "@fluentui/react-components";
import { useMemo } from "react";

type CountOption = {
  key: string;
  label: string;
  count: number;
  selected?: boolean;
};

type CountOptionListProps = {
  options: CountOption[];
  onSelect: (optionKey: string) => void;
};

const useStyles = makeStyles({
  list: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingHorizontalXS,
  },
  button: {
    justifyContent: "flex-start",
  },
  countText: {
    color: tokens.colorNeutralForeground3,
    opacity: 0.82,
  },
});

export const CountOptionList = ({ options, onSelect }: CountOptionListProps) => {
  const styles = useStyles();
  const formatNumber = useMemo(() => new Intl.NumberFormat(), []);

  if (options.length === 0) {
    return null;
  }

  return (
    <div className={styles.list}>
      {options.map((option) => (
        <Button
          key={option.key}
          size="small"
          appearance={option.selected ? "primary" : "subtle"}
          className={styles.button}
          onClick={() => onSelect(option.key)}
        >
          <span>{option.label}</span>
          <span className={styles.countText}>{` (${formatNumber.format(option.count)})`}</span>
        </Button>
      ))}
    </div>
  );
};
