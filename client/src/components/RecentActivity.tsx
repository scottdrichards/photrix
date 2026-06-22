import css from "./RecentActivity.module.css";

type RecentMaintenance = {
  folder: string;
  fileName: string;
  completedAt: number | string;
};

type RecentActivityProps = {
  label: string;
  entry: RecentMaintenance | null;
};

export const RecentActivity = ({ label, entry }: RecentActivityProps) => {
  const description = entry
    ? `${entry.folder}${entry.fileName} (${new Date(entry.completedAt).toLocaleTimeString()})`
    : "No activity yet";

  return (
    <span>
      <span className={css.label}>{label}:</span>
      <span className={css.value}>{description}</span>
    </span>
  );
};
