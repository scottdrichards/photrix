import { useMemo, useState } from "react";
import type { TranscriptSegment } from "../../api/types";
import { fold, MIN_QUERY_LENGTH } from "./TranscriptSearch";
import { formatDuration } from "./photoInfoFormat";
import css from "./TranscriptPanel.module.css";

type Word = { text: string; at: number };

/** The words of a caption with each one's character offset. */
const wordsOf = (text: string): Word[] =>
  [...text.matchAll(/\S+/g)].map((m) => ({ text: m[0], at: m.index ?? 0 }));

/**
 * Captions are timed per line, not per word, so a word's time is estimated
 * from where it sits in the line.
 */
export const wordTime = (segment: TranscriptSegment, charOffset: number): number => {
  const length = Math.max(segment.text.length, 1);
  return segment.start + ((segment.end - segment.start) * charOffset) / length;
};

/** Character ranges of the (folded) query within a caption. */
const matchRanges = (text: string, needle: string): Array<[number, number]> => {
  if (!needle) return [];
  const haystack = fold(text);
  const ranges: Array<[number, number]> = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
    ranges.push([at, at + needle.length]);
  }
  return ranges;
};

type Props = {
  segments: TranscriptSegment[];
  /** Seek the video to this many seconds. */
  onSeek: (seconds: number) => void;
};

/**
 * The video's transcript in the info panel, collapsed until opened. Click a
 * word to play from there; the box narrows the transcript to what matches.
 */
export const TranscriptPanel = ({ segments, onSeek }: Props) => {
  const [query, setQuery] = useState("");
  const needle = fold(query.trim());
  const searching = needle.length >= MIN_QUERY_LENGTH;
  const ordered = useMemo(() => [...segments].sort((a, b) => a.start - b.start), [segments]);
  const rows = useMemo(
    () =>
      ordered
        .map((segment) => ({ segment, ranges: searching ? matchRanges(segment.text, needle) : [] }))
        .filter((row) => !searching || row.ranges.length > 0),
    [ordered, needle, searching],
  );

  return (
    <details className={css.transcript}>
      <summary className={css.summary}>Transcript</summary>
      <input
        className={css.input}
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        // Arrow keys page the viewer and Escape closes it; in the box they are the text's.
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Escape") e.stopPropagation();
        }}
        placeholder="Search transcript"
        aria-label="Search transcript"
      />
      {searching && (
        <p className={css.count} role="status">
          {rows.length === 0
            ? "Not said in this video"
            : `${rows.length} ${rows.length === 1 ? "line" : "lines"}`}
        </p>
      )}
      <ol className={css.lines}>
        {rows.map(({ segment, ranges }) => (
          <li key={`${segment.start}-${segment.end}`} className={css.line}>
            <button
              type="button"
              className={css.time}
              onClick={() => onSeek(segment.start)}
              aria-label={`Play from ${formatDuration(segment.start)}`}
            >
              {formatDuration(segment.start)}
            </button>
            <span>
              {wordsOf(segment.text).map((word) => {
                const end = word.at + word.text.length;
                const hit = ranges.some(([from, to]) => word.at < to && end > from);
                return (
                  <span key={word.at}>
                    <button
                      type="button"
                      className={hit ? css.wordHit : css.word}
                      onClick={() => onSeek(wordTime(segment, word.at))}
                    >
                      {word.text}
                    </button>{" "}
                  </span>
                );
              })}
            </span>
          </li>
        ))}
      </ol>
    </details>
  );
};
