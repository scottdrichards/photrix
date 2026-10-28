import type { PhotoPersonFace } from "../api/types";
import { formatClock, videoTimelineRows } from "./videoPeople";
import css from "./VideoPeopleTimeline.module.css";

type VideoPeopleTimelineProps = {
  faces: readonly PhotoPersonFace[];
  /** The video's length; without it the bars scale to the last appearance. */
  durationMs?: number;
  onSeek: (ms: number) => void;
};

/**
 * Who is in this video and when: one row per person, with their on-screen
 * stretches drawn along the video's length. Click a stretch to jump to it, or
 * jump straight to someone's first or longest appearance.
 *
 * Stretches on long videos are coarse (the face pass samples a long video at
 * a few dozen points), so this is for finding someone, not for frame-exact
 * edits.
 */
export const VideoPeopleTimeline = ({
  faces,
  durationMs,
  onSeek,
}: VideoPeopleTimelineProps) => {
  const people = videoTimelineRows(faces);
  if (people.length === 0) return null;
  const spanMs = Math.max(
    durationMs ?? 0,
    ...people.flatMap((p) => p.appearances.map((a) => a.endMs)),
    1,
  );
  const pct = (ms: number) => `${Math.min(100, Math.max(0, (ms / spanMs) * 100))}%`;

  return (
    <div className={css.timeline} data-testid="video-people">
      {people.map((person) => {
        const label =
          person.name ??
          (person.pooledCount ? `${person.pooledCount} unnamed` : "Unnamed");
        return (
          <div className={css.row} key={person.personId}>
            <span className={css.name} title={label}>
              {label}
            </span>
            <div className={css.track}>
              {person.appearances.map((a) => (
                <button
                  key={a.startMs}
                  type="button"
                  className={`${css.segment} ${a === person.longest ? css.longest : ""}`}
                  style={{
                    left: pct(a.startMs),
                    width: `max(4px, ${pct(a.endMs - a.startMs)})`,
                  }}
                  title={`${label}: ${formatClock(a.startMs)}–${formatClock(a.endMs)}`}
                  aria-label={`Jump to ${label} at ${formatClock(a.startMs)}`}
                  onClick={() => onSeek(a.startMs)}
                />
              ))}
            </div>
            <button
              type="button"
              className={`btn btn-transparent btn-sm ${css.jump}`}
              onClick={() => onSeek(person.first.startMs)}
              title={`First seen at ${formatClock(person.first.startMs)}`}
            >
              First
            </button>
            <button
              type="button"
              className={`btn btn-transparent btn-sm ${css.jump}`}
              onClick={() => onSeek(person.longest.startMs)}
              title={`Longest stretch: ${formatClock(person.longest.startMs)}–${formatClock(person.longest.endMs)}`}
              disabled={person.appearances.length < 2}
            >
              Longest
            </button>
          </div>
        );
      })}
    </div>
  );
};
