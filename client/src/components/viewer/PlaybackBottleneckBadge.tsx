import { useState } from "react";
import { DeveloperBoard20Filled, WifiWarning20Filled } from "@fluentui/react-icons";
import type { BottleneckReport } from "./playbackBottleneck";
import css from "./PlaybackBottleneckBadge.module.css";

const explain = (report: BottleneckReport): string =>
  report.kind === "network"
    ? `The connection is the bottleneck: this quality needs about ${report.neededMbps} Mbit/s and it is getting ${report.gettingMbps}. A lower quality will play smoother.`
    : `The server is the bottleneck: it is encoding this quality at ${report.encodeSpeed}× realtime, slower than it plays. A lower quality will play smoother.`;

/**
 * Says why a video is buffering, while it is (feedback #178): a red network
 * icon when the connection can't carry the stream, a processor icon when the
 * server can't encode it fast enough. Tap or hover for the numbers.
 */
export const PlaybackBottleneckBadge = ({
  report,
}: {
  report: BottleneckReport | null;
}) => {
  const [open, setOpen] = useState(false);
  if (!report) return null;
  const text = explain(report);
  const network = report.kind === "network";
  return (
    <div className={css.root}>
      <button
        type="button"
        className={`${css.badge} ${network ? css.network : css.encoder}`}
        aria-label={text}
        aria-expanded={open}
        title={text}
        data-testid="playback-bottleneck"
        data-kind={report.kind}
        onClick={(event) => {
          // The viewer's container click toggles chrome / closes; keep this tap.
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        {network ? <WifiWarning20Filled /> : <DeveloperBoard20Filled />}
      </button>
      {open && (
        <span className={css.explanation} role="status">
          {text}
        </span>
      )}
    </div>
  );
};
