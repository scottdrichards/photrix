import { useEffect, useRef, useState } from "react";
import {
  ClosedCaption24Regular,
  Image24Regular,
  MusicNote224Regular,
} from "@fluentui/react-icons";
import {
  fetchSearchStatus,
  type SearchModelState,
  type SearchSource,
  type SearchSourceStatus,
} from "../api";
import { Spinner } from "../Spinner";
import css from "./SearchStatus.module.css";

const SOURCE_ORDER: SearchSource[] = ["image", "audio", "transcript"];

const SOURCE_NAMES: Record<SearchSource, string> = {
  image: "Images",
  audio: "Audio",
  transcript: "Transcripts",
};

/** Singular form for "<X> matches aren't included". */
const MATCH_NAMES: Record<SearchSource, string> = {
  image: "Image",
  audio: "Audio",
  transcript: "Transcript",
};

const SOURCE_ICONS: Record<SearchSource, React.ReactNode> = {
  image: <Image24Regular fontSize={14} />,
  audio: <MusicNote224Regular fontSize={14} />,
  transcript: <ClosedCaption24Regular fontSize={14} />,
};

const POLL_MS = 1_000;
/** Don't flash a progress strip for a search that answers almost at once. */
const SHOW_PROGRESS_AFTER_MS = 400;
/** Stop waiting for a model to finish loading after a failed search. */
const MAX_RECOVERY_POLL_MS = 120_000;

/**
 * Poll /api/search/status while `active`. Returns the latest per-source model
 * states, or null before the first answer (or when polling is off). Errors are
 * swallowed: this is a best-effort hint, never a reason to break search.
 */
export const useSearchModelStates = (
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
        .catch(() => {})
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

const progressText = (source: SearchSource, state: SearchModelState | undefined) => {
  if (source === "transcript") return "searching";
  switch (state) {
    case "ready":
      return "searching";
    case "loading":
    case "cold":
      return "loading model…";
    case "unavailable":
      return "off";
    default:
      return "starting…";
  }
};

const FAILURE_TEXT = {
  loading: "the model was still loading",
  timeout: "it took too long to answer",
  error: "it failed",
} as const;

type SearchStatusProps = {
  /** A first-page search is in flight. */
  searching: boolean;
  /** Per-source outcome of the last completed search, if any. */
  outcome: SearchSourceStatus | null;
  /** Sources the user has enabled for this search. */
  enabledSources: readonly SearchSource[];
  onRetry: () => void;
};

/**
 * Explains what search is doing, so a slow or partial result is never a
 * mystery. While a search runs: which sources are searching and which are
 * still loading a model. Afterwards: which sources are missing from the
 * results and why, with a Retry that lights up once the model is ready.
 */
export const SearchStatus = ({
  searching,
  outcome,
  enabledSources,
  onRetry,
}: SearchStatusProps) => {
  const [showProgress, setShowProgress] = useState(false);
  useEffect(() => {
    if (!searching) {
      setShowProgress(false);
      return;
    }
    const timer = setTimeout(() => setShowProgress(true), SHOW_PROGRESS_AFTER_MS);
    return () => clearTimeout(timer);
  }, [searching]);

  const failed = SOURCE_ORDER.filter(
    (source) => outcome?.[source]?.status === "failed",
  );
  const awaitingModel = failed.filter((source) => {
    const o = outcome?.[source];
    return o?.status === "failed" && o.reason === "loading";
  });

  // After a partial result, keep watching until the missing model is ready —
  // but not forever, in case it never comes back.
  const [recoveryExpired, setRecoveryExpired] = useState(false);
  const outcomeRef = useRef(outcome);
  useEffect(() => {
    outcomeRef.current = outcome;
    setRecoveryExpired(false);
    if (awaitingModel.length === 0) return;
    const timer = setTimeout(() => setRecoveryExpired(true), MAX_RECOVERY_POLL_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome]);

  const states = useSearchModelStates(
    searching || (!recoveryExpired && awaitingModel.length > 0),
  );
  const nowReady =
    awaitingModel.length > 0 &&
    awaitingModel.every((source) => states?.[source] === "ready");

  const visibleSources = SOURCE_ORDER.filter((source) => enabledSources.includes(source));

  if (searching && showProgress) {
    const anyLoading = visibleSources.some(
      (source) => source !== "transcript" && states?.[source] !== "ready",
    );
    return (
      <div className={css.strip} role="status" aria-live="polite">
        <Spinner size="extra-tiny" />
        <span className={css.lead}>Searching</span>
        {visibleSources.map((source) => {
          const text = progressText(source, states?.[source]);
          return (
            <span
              key={source}
              className={css.chip}
              data-state={text === "searching" ? "active" : "waiting"}
            >
              {SOURCE_ICONS[source]}
              {SOURCE_NAMES[source]}: {text}
            </span>
          );
        })}
        {anyLoading && states && (
          <span className={css.hint}>
            A model that isn't loaded yet can take up to 15 s on the first search.
          </span>
        )}
      </div>
    );
  }

  if (!searching && failed.length > 0) {
    return (
      <div className={css.notice} role="status" aria-live="polite">
        <div className={css.noticeText}>
          {failed.map((source) => {
            const o = outcome?.[source];
            const reason = o?.status === "failed" ? FAILURE_TEXT[o.reason] : "";
            return (
              <div key={source} className={css.noticeLine}>
                {SOURCE_ICONS[source]}
                <span>
                  {MATCH_NAMES[source]} matches aren&apos;t included: {reason}.
                </span>
              </div>
            );
          })}
          {awaitingModel.length > 0 && (
            <div className={css.noticeState}>
              {nowReady ? (
                "Ready now. Retry to include them."
              ) : recoveryExpired ? (
                "Still not ready."
              ) : (
                <>
                  <Spinner size="extra-tiny" /> Waiting for the model to finish loading…
                </>
              )}
            </div>
          )}
        </div>
        <button
          type="button"
          className={css.retry}
          data-ready={nowReady || undefined}
          onClick={onRetry}
        >
          Retry
        </button>
      </div>
    );
  }

  return null;
};
