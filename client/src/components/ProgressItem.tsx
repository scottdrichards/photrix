import {
  ProgressBar,
  makeStyles,
  tokens,
  Text,
} from "@fluentui/react-components";
import type { ProgressEntry } from "../api";

const useStyles = makeStyles({
  progressCard: {
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingHorizontalM,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  progressHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: tokens.spacingVerticalS,
  },
  label: {
    fontWeight: tokens.fontWeightSemibold,
  },
  percent: {
    fontSize: tokens.fontSizeBase200,
  },
  muted: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
});

interface ProgressItemProps {
  label: string;
  progress: ProgressEntry;
  detail?: string;
  eta?: string | null;
}

export const ProgressItem = ({ label, progress, detail, eta }: ProgressItemProps) => {
  const styles = useStyles();
  const percentFormatter = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 0 });

  return (
    <div className={styles.progressCard}>
      <div className={styles.progressHeader}>
        <Text className={styles.label}>{label}</Text>
        <Text className={styles.percent}>{percentFormatter.format(progress.percent)}</Text>
      </div>
      <ProgressBar value={progress.percent} max={1} />
      <Text className={styles.muted}>
        {progress.completed.toLocaleString()} / {progress.total.toLocaleString()} ready
        {detail ? ` • ${detail}` : ""}
        {eta ? ` • ETA: ${eta}` : ""}
      </Text>
    </div>
  );
};
