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

/**
 * Says so when a video can't play, with a retry. Nothing while it loads or
 * buffers (feedback #175): the browser's own controls already show that, and
 * a second "Buffering…" on top told the viewer nothing new.
 */
export const VideoLoadingOverlay = ({
  state,
  onRetry,
}: {
  state: PlaybackState;
  onRetry: () => void;
}) => {
  if (state.phase !== "unavailable") return null;
  return (
    <div className={css.overlay} role="alert">
      <strong>Can&apos;t play this video</strong>
      {state.detail && <span className={css.detail}>{state.detail}</span>}
      <button type="button" className={css.retry} onClick={onRetry}>
        Retry
      </button>
    </div>
  );
};
