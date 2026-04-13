import css from "./ProgressItem.module.css";
import type { ProgressEntry } from "../api";

type ProgressItemProps = {
  label: string;
  progress: ProgressEntry;
  detail?: string;
  eta?: string | null;
  summaryLabel?: string;
  valueFormatter?: (value: number) => string;
};

export const ProgressItem = ({
  label,
  progress,
  detail,
  eta,
  summaryLabel = "ready",
  valueFormatter = (value: number) => value.toLocaleString(),
}: ProgressItemProps) => {
  const percentFormatter = new Intl.NumberFormat("en-US", {
    style: "percent",
    maximumFractionDigits: 0,
  });

  return (
    <div className={css.progressCard}>
      <div className={css.progressHeader}>
        <span className={css.label}>{label}</span>
        <span className={css.percent}>
          {percentFormatter.format(progress.percent)}
        </span>
      </div>
      <progress value={progress.percent} max={1} />
      <span className={css.muted}>
        {valueFormatter(progress.completed)} / {valueFormatter(progress.total)} {summaryLabel}
        {detail ? ` • ${detail}` : ""}
        {eta ? ` • ETA: ${eta}` : ""}
      </span>
    </div>
  );
};
