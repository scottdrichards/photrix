import { useEffect, useId, useRef, useState } from "react";
import {
  ArrowClockwise16Regular,
  CheckmarkCircle16Regular,
  ClosedCaption24Regular,
  Image24Regular,
  MusicNote224Regular,
  Warning16Filled,
} from "@fluentui/react-icons";
import {
  fetchSearchStatus,
  type SearchModelState,
  type SearchSource,
  type SearchSourceOutcome,
} from "../../api";
import { useSearchActivity } from "./searchActivity";
import { logFailure } from "../../logFailure";
import css from "./SearchStatus.module.css";

const SOURCE_ORDER: SearchSource[] = ["image", "audio", "transcript"];

const SOURCE_NAMES: Record<SearchSource, string> = {
  image: "Images",
  audio: "Audio",
  transcript: "Transcripts",
};

const SOURCE_ICONS: Record<SearchSource, React.ReactNode> = {
  image: <Image24Regular fontSize={14} />,
  audio: <MusicNote224Regular fontSize={14} />,
  transcript: <ClosedCaption24Regular fontSize={14} />,
};

const POLL_MS = 1_000;
/** Stop waiting for a model to finish loading after a failed search. */
const MAX_RECOVERY_POLL_MS = 120_000;

/**
 * Poll /api/search/status while `active`. Returns the latest per-source model
 * states, or null before the first answer (or when polling is off). A failed
 * poll is logged and the next one retries: this is a hint, never a reason to
 * break search.
 */
const useSearchModelStates = (
  active: boolean,
): Partial<Record<SearchSource, SearchModelState>> | null => {
  const [states, setStates] =
    useState<Partial<Record<SearchSource, SearchModelState>> | null>(null);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => {
      fetchSearchStatus(controller.signal)
        .then((next) => setStates(next))
        .catch((error: unknown) => {
          // Disposal aborts with a string reason, which isAbort doesn't recognise.
          if (!controller.signal.aborted) {
            logFailure("search.status.failed", "Could not read search status")(error);
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) timer = setTimeout(poll, POLL_MS);
        });
    };
    poll();
    return () => {
      controller.abort("disposed");
      clearTimeout(timer);
    };
  }, [active]);

  return states;
};

/** How one ring segment / popover row looks. */
type Phase = "done" | "active" | "pending" | "failed" | "off";

type Row = { source: SearchSource; phase: Phase; text: string };

const FAILURE_TEXT = {
  loading: "left out: model still loading",
  timeout: "left out: too slow to answer",
  error: "left out: failed",
} as const;

/** A source while the search is in flight, from its model's readiness. */
const rowWhileSearching = (source: SearchSource, state: SearchModelState | undefined): Row => {
  // Transcript search is plain SQL: there is no model to wait for.
  if (source === "transcript" || state === "ready") {
    return { source, phase: "active", text: "searching…" };
  }
  if (state === "unavailable") return { source, phase: "off", text: "off on this server" };
  if (state === "loading" || state === "cold") {
    return { source, phase: "pending", text: "loading model…" };
  }
  return { source, phase: "pending", text: "starting…" };
};

/**
 * A source after the search answered, from its reported outcome. With no
 * per-source report at all (an API that predates it), the search still
 * finished: say "done" rather than claim nothing was searched.
 */
const rowAfterSearch = (
  source: SearchSource,
  outcome: SearchSourceOutcome | undefined,
  reported: boolean,
): Row => {
  if (!reported) return { source, phase: "done", text: "done" };
  if (!outcome || outcome.status === "skipped") {
    return { source, phase: "off", text: "not searched" };
  }
  if (outcome.status === "failed") {
    return { source, phase: "failed", text: FAILURE_TEXT[outcome.reason] };
  }
  return {
    source,
    phase: "done",
    text: outcome.ms === undefined ? "done" : `done in ${formatMs(outcome.ms)}`,
  };
};

const formatMs = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

const RING_SIZE = 20;
const RING_RADIUS = 8;
const RING_GAP_DEG = 18;

/** One arc per source, so the icon itself shows how far along the search is. */
const ProgressRing = ({ rows, spinning }: { rows: Row[]; spinning: boolean }) => {
  const count = Math.max(rows.length, 1);
  const sweep = 360 / count;
  const circumference = 2 * Math.PI * RING_RADIUS;
  const arcLength = (circumference * (sweep - RING_GAP_DEG)) / 360;
  return (
    <svg
      className={css.ring}
      data-spinning={spinning || undefined}
      width={RING_SIZE}
      height={RING_SIZE}
      viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      aria-hidden="true"
    >
      {rows.map((row, i) => (
        <circle
          key={row.source}
          className={css.segment}
          data-phase={row.phase}
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RING_RADIUS}
          fill="none"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeDasharray={`${arcLength} ${circumference}`}
          transform={`rotate(${-90 + i * sweep + RING_GAP_DEG / 2} ${RING_SIZE / 2} ${RING_SIZE / 2})`}
        />
      ))}
    </svg>
  );
};

/**
 * The search bar's status icon (feedback #143). While a search runs it is a
 * ring with one arc per source that fills as each source gets going; after it
 * answers it is a check, or a warning when a source was left out. Hovering,
 * focusing or tapping it lists every source and its status, with Retry when
 * something is missing (highlighted once the missing model is ready).
 */
export const SearchStatusIcon = () => {
  const { active, searching, outcome, enabledSources, retry } = useSearchActivity();
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const popoverId = useId();

  const visibleSources = SOURCE_ORDER.filter((source) => enabledSources.includes(source));
  const failed = searching
    ? []
    : visibleSources.filter((source) => outcome?.[source]?.status === "failed");
  const awaitingModel = failed.filter((source) => {
    const o = outcome?.[source];
    return o?.status === "failed" && o.reason === "loading";
  });

  // After a partial result, keep watching until the missing model is ready,
  // but not forever, in case it never comes back.
  const [recoveryExpired, setRecoveryExpired] = useState(false);
  useEffect(() => {
    setRecoveryExpired(false);
    if (awaitingModel.length === 0) return;
    const timer = setTimeout(() => setRecoveryExpired(true), MAX_RECOVERY_POLL_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome]);

  const states = useSearchModelStates(
    active && (searching || (!recoveryExpired && awaitingModel.length > 0)),
  );
  const nowReady =
    awaitingModel.length > 0 && awaitingModel.every((source) => states?.[source] === "ready");

  // A tap outside closes a pinned popover.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setPinned(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  if (!active || visibleSources.length === 0) return null;

  const rows = visibleSources.map((source) =>
    searching
      ? rowWhileSearching(source, states?.[source])
      : rowAfterSearch(source, outcome?.[source], outcome !== null),
  );
  const anyLoadingModel = searching && rows.some((row) => row.text === "loading model…");

  const summary = searching
    ? "Searching"
    : failed.length > 0
      ? `${failed.length === 1 ? "1 source" : `${failed.length} sources`} left out`
      : outcome
        ? "All sources answered"
        : "Search finished";

  let glyph: React.ReactNode;
  if (searching) glyph = <ProgressRing rows={rows} spinning />;
  else if (failed.length > 0) glyph = <Warning16Filled className={css.warning} />;
  else glyph = <CheckmarkCircle16Regular className={css.ok} />;

  const close = () => {
    setOpen(false);
    setPinned(false);
  };

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- hover mirrors the button, which is the real control; Escape bubbles up from the button and popover
    <div
      ref={wrapperRef}
      className={css.wrapper}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => {
        if (!pinned) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") close();
      }}
    >
      <button
        type="button"
        className={css.iconButton}
        data-state={searching ? "searching" : failed.length > 0 ? "failed" : "done"}
        data-ready={nowReady || undefined}
        aria-label={`Search status: ${summary}`}
        aria-expanded={open}
        aria-controls={popoverId}
        onClick={() => {
          // Touch has no hover, so a tap pins the details open; a second tap
          // closes them.
          if (pinned) close();
          else {
            setOpen(true);
            setPinned(true);
          }
        }}
        onFocus={() => setOpen(true)}
        onBlur={(event) => {
          if (!pinned && !wrapperRef.current?.contains(event.relatedTarget as Node)) setOpen(false);
        }}
      >
        {glyph}
      </button>
      {open && (
        <div id={popoverId} className={css.popover} role="status" aria-live="polite">
          <div className={css.title}>{summary}</div>
          <ul className={css.rows}>
            {rows.map((row) => (
              <li key={row.source} className={css.row} data-phase={row.phase}>
                <span className={css.dot} data-phase={row.phase} aria-hidden="true" />
                {SOURCE_ICONS[row.source]}
                <span className={css.name}>{SOURCE_NAMES[row.source]}</span>
                <span className={css.text}>{row.text}</span>
              </li>
            ))}
          </ul>
          {anyLoadingModel && (
            <div className={css.hint}>A model that isn&apos;t loaded can take up to 15 s.</div>
          )}
          {failed.length > 0 && retry && (
            <div className={css.retryRow}>
              <span className={css.hint}>
                {awaitingModel.length === 0
                  ? "Retry to try again."
                  : nowReady
                    ? "Ready now. Retry to include them."
                    : recoveryExpired
                      ? "Still not ready."
                      : "Waiting for the model to finish loading…"}
              </span>
              <button
                type="button"
                className={css.retry}
                data-ready={nowReady || undefined}
                onClick={() => {
                  close();
                  retry();
                }}
              >
                <ArrowClockwise16Regular /> Retry
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
