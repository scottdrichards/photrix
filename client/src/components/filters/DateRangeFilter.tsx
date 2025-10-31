import { Input, Label, makeStyles, tokens } from "@fluentui/react-components";

const useStyles = makeStyles({
  container: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
  },
  dateRow: {
    display: "flex",
    gap: tokens.spacingHorizontalS,
    alignItems: "center",
  },
  dateInput: {
    flex: 1,
  },
});

export type DateRangeFilterProps = {
  value?: {
    start?: string;
    end?: string;
  };
  onChange: (range?: { start?: string; end?: string }) => void;
};

export const DateRangeFilter = ({ value, onChange }: DateRangeFilterProps) => {
  const styles = useStyles();

  const handleStartChange = (newStart: string) => {
    const start = newStart || undefined;
    if (!start && !value?.end) {
      onChange(undefined);
    } else {
      onChange({ start, end: value?.end });
    }
  };

  const handleEndChange = (newEnd: string) => {
    const end = newEnd || undefined;
    if (!end && !value?.start) {
      onChange(undefined);
    } else {
      onChange({ start: value?.start, end });
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.dateRow}>
        <Label htmlFor="date-start" style={{ minWidth: "40px" }}>
          From
        </Label>
        <Input
          id="date-start"
          type="date"
          value={value?.start ?? ""}
          onChange={(_, data) => handleStartChange(data.value)}
          className={styles.dateInput}
        />
      </div>
      <div className={styles.dateRow}>
        <Label htmlFor="date-end" style={{ minWidth: "40px" }}>
          To
        </Label>
        <Input
          id="date-end"
          type="date"
          value={value?.end ?? ""}
          onChange={(_, data) => handleEndChange(data.value)}
          className={styles.dateInput}
        />
      </div>
    </div>
  );
};
