import type {
  AnalysisCoverage,
  BackgroundTaskStatus,
} from "../../../shared/filter-contract/src";
import css from "./StatusModal.module.css";

const count = (value: number) => value.toLocaleString();

const formatRetryDate = (epochMs: number) =>
  new Date(epochMs).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** "11,086 of 11,338 videos done · 234 retry from Nov 4 · 11 unreadable" */
export const describeCoverage = (coverage: AnalysisCoverage): string => {
  const { done, waiting, retrying, unreadable, unit, nextRetryAt } = coverage;
  const total = done + waiting + retrying + unreadable;
  const parts = [`${count(done)} of ${count(total)} ${unit} done`];
  if (waiting > 0) parts.push(`${count(waiting)} waiting to start`);
  if (retrying > 0) {
    parts.push(
      nextRetryAt
        ? `${count(retrying)} failed, retrying from ${formatRetryDate(nextRetryAt)}`
        : `${count(retrying)} failed, will retry`,
    );
  }
  if (unreadable > 0) parts.push(`${count(unreadable)} unreadable`);
  return parts.join(" · ");
};

type Props = {
  coverage: AnalysisCoverage[] | undefined;
  tasks: BackgroundTaskStatus[];
};

/**
 * Feedback #158: a library-wide pass that is not running (finished, or resting
 * while its failures cool down) used to vanish from the status, leaving no way
 * to tell "done" from "stuck". A pass that is running shows its own progress
 * above, so only the others are listed here.
 */
export const StatusCoverage = ({ coverage, tasks }: Props) => {
  const running = new Set(tasks.map(({ name }) => name));
  const idle = (coverage ?? []).filter(({ name }) => !running.has(name));
  if (idle.length === 0) return null;

  return (
    <div className={css.taskList} data-testid="status-coverage">
      <span className={css.label}>Not running</span>
      {idle.map((entry) => (
        <div className={css.taskRow} key={entry.name}>
          <span className={css.value}>{entry.name}</span>
          <small>{describeCoverage(entry)}</small>
        </div>
      ))}
    </div>
  );
};
