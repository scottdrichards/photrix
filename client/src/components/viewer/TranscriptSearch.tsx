import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Dismiss16Regular } from "@fluentui/react-icons";
import type { TranscriptSegment } from "../../api/types";
import { formatDuration } from "./photoInfoFormat";
import css from "./TranscriptSearch.module.css";

const MIN_QUERY_LENGTH = 2;

/** Case- and accent-insensitive form, one character per input character. */
const fold = (text: string): string =>
  [...text].map((ch) => ch.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase() || ch).join("");

/** Every caption containing the query, in playback order. */
export const findInTranscript = (
  segments: TranscriptSegment[],
  query: string,
): TranscriptSegment[] => {
  const needle = fold(query.trim());
  if (needle.length < MIN_QUERY_LENGTH) return [];
  return segments
    .filter((segment) => fold(segment.text).includes(needle))
    .sort((a, b) => a.start - b.start);
};

/** The caption text with each match wrapped in <mark>. */
const highlight = (text: string, query: string): ReactNode[] => {
  const needle = fold(query.trim());
  const haystack = fold(text);
  const parts: ReactNode[] = [];
  let from = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, from)) {
    if (at > from) parts.push(text.slice(from, at));
    parts.push(<mark key={at}>{text.slice(at, at + needle.length)}</mark>);
    from = at + needle.length;
  }
  if (from < text.length) parts.push(text.slice(from));
  return parts;
};

type Props = {
  segments: TranscriptSegment[];
  /** Seek the video to this many seconds. */
  onSeek: (seconds: number) => void;
  onClose: () => void;
};

/**
 * Feedback #169: find where something is said in a video, e.g. a name, by
 * searching its transcript and jumping to the caption.
 */
export const TranscriptSearch = ({ segments, onSeek, onClose }: Props) => {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // Opened by a tap on "Search captions", so typing should go straight in.
  useEffect(() => inputRef.current?.focus(), []);
  const matches = useMemo(() => findInTranscript(segments, query), [segments, query]);
  const searching = query.trim().length >= MIN_QUERY_LENGTH;

  // The viewer closes on Escape and pages photos on the arrow keys; inside the
  // box those keys belong to the text.
  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") e.stopPropagation();
    if (e.key === "Enter" && matches.length > 0) onSeek(matches[0].start);
  };

  return (
    <div className={css.panel} role="search" aria-label="Find in captions">
      <div className={css.inputRow}>
        <input
          ref={inputRef}
          className={css.input}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Find in captions"
          aria-label="Find in captions"
        />
        <button type="button" className={css.close} onClick={onClose} aria-label="Close caption search">
          <Dismiss16Regular />
        </button>
      </div>
      {searching && (
        <p className={css.count} role="status">
          {matches.length === 0
            ? "Not said in this video"
            : `${matches.length} ${matches.length === 1 ? "place" : "places"}`}
        </p>
      )}
      {matches.length > 0 && (
        <ul className={css.results}>
          {matches.map((segment) => (
            <li key={`${segment.start}-${segment.end}`}>
              <button type="button" className={css.result} onClick={() => onSeek(segment.start)}>
                <span className={css.time}>{formatDuration(segment.start)}</span>
                <span className={css.text}>{highlight(segment.text, query)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
