import {
  makeStyles,
  tokens,
  Text,
} from "@fluentui/react-components";
import type { RecentMaintenance } from "../api";

const useStyles = makeStyles({
  label: {
    fontWeight: tokens.fontWeightSemibold,
  },
  value: {
    marginLeft: tokens.spacingHorizontalS,
  },
});

interface RecentActivityProps {
  label: string;
  entry: RecentMaintenance | null;
}

export const RecentActivity = ({ label, entry }: RecentActivityProps) => {
  const styles = useStyles();
  const description = entry
    ? `${entry.relativePath} (${new Date(entry.completedAt).toLocaleTimeString()})`
    : "No activity yet";

  return (
    <Text>
      <span className={styles.label}>{label}:</span>
      <span className={styles.value}>{description}</span>
    </Text>
  );
};
