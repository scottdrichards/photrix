import { useEffect, useState } from "react";
import { Spinner } from "../Spinner";
import css from "./VideoLoadingOverlay.module.css";

type PlaybackPhase =
  | "idle"
  | "measuring"
  | "negotiating"
  | "starting"
  | "buffering"
  | "playing"
  | "unavailable";

export type PlaybackState = {
  phase: PlaybackPhase;
  /** When the phase began (Date.now()). */
  since: number;
  /** "starting": what is being started. "unavailable": why it can't play. */
  detail?: string;
};

const LABELS: Partial<Record<PlaybackPhase, string>> = {
  measuring: "Checking your connection…",
  negotiating: "Choosing a stream…",
  buffering: "Buffering…",
};

// Past this long with no bytes from the server, the stream is probably stuck
// rather than slow, so say so and offer a retry instead of spinning forever.
const STUCK_AFTER_MS = 15_000;

/**
 * Answers "did it break or is it still churning?" while a video loads: what the
 * player is waiting on, for how long, and when data last arrived. Phases are
 * driven by FullscreenViewer's playback effect.
 */
export const VideoLoadingOverlay = ({
  state,
  lastDataAtRef,
  onRetry,
}: {
  state: PlaybackState;
  /** When bytes last arrived; read on this component's own 1s tick. */
  lastDataAtRef: { readonly current: number };
  onRetry: () => void;
}) => {
  const [now, setNow] = useState(Date.now);
  const waiting = state.phase !== "idle" && state.phase !== "playing";
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [waiting]);
  if (!waiting) return null;

  const retry = (
    <button type="button" className={css.retry} onClick={onRetry}>
      Retry
    </button>
  );

  if (state.phase === "unavailable") {
    return (
      <div className={css.overlay} role="alert">
        <strong>Can&apos;t play this video</strong>
        {state.detail && <span className={css.detail}>{state.detail}</span>}
        {retry}
      </div>
    );
  }

  const lastDataAt = lastDataAtRef.current;
  const elapsedS = Math.max(0, Math.floor((now - state.since) / 1_000));
  const silentMs = now - Math.max(lastDataAt, state.since);
  const loadingData = state.phase === "starting" || state.phase === "buffering";
  return (
    <div className={css.overlay} role="status">
      <Spinner
        label={`${LABELS[state.phase] ?? state.detail ?? ""}${elapsedS >= 2 ? ` ${elapsedS}s` : ""}`}
      />
      {loadingData && silentMs >= STUCK_AFTER_MS ? (
        <>
          <span className={css.detail}>
            No data from the server for {Math.floor(silentMs / 1_000)}s. It may be stuck.
          </span>
          {retry}
        </>
      ) : loadingData && lastDataAt > state.since ? (
        <span className={css.detail}>
          Receiving data (last {Math.floor(silentMs / 1_000)}s ago)
        </span>
      ) : null}
    </div>
  );
};
