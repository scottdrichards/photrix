import { useEffect, useState, type RefObject } from "react";
import {
  planStoryboard,
  storyboardFrameAt,
} from "../../../../shared/video-storyboard/src";
import { buildFileUrl } from "../../api/photoItem";
import css from "./VideoScrubPreview.module.css";

type Props = {
  videoRef: RefObject<HTMLVideoElement | null>;
  path: string;
  /** The video's length in seconds, from its metadata. */
  durationSeconds: number | null | undefined;
  /** Width over height, once the video knows it. */
  aspectRatio: number | null;
};

type Preview = { frame: number; seconds: number; fraction: number };

const formatTime = (seconds: number): string => {
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = String(whole % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
};

/**
 * Feedback #168: while the video is being dragged through, shows a small
 * frame from that moment straight away, YouTube-style, instead of waiting
 * for the stream to fetch and decode the real one.
 *
 * The player uses the browser's own controls, so there is no scrub bar to
 * hook. What every browser does report is `seeking` — fired for each step of
 * a drag, by mouse or finger — and `seeked` once the real frame is there.
 * The frames come from one storyboard sprite per video (server-built, laid
 * out by shared/video-storyboard), loaded when the video opens so the first
 * drag already has it.
 */
export const VideoScrubPreview = ({ videoRef, path, durationSeconds, aspectRatio }: Props) => {
  const plan = planStoryboard(durationSeconds);
  const url = plan ? buildFileUrl(path, { representation: "storyboard" }) : null;
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (!cancelled) setLoadedUrl(url);
    };
    image.src = url;
    return () => {
      cancelled = true;
      image.onload = null;
    };
  }, [url]);

  const ready = plan !== null && loadedUrl === url;

  useEffect(() => {
    const video = videoRef.current;
    const layout = planStoryboard(durationSeconds);
    if (!video || !ready || !layout) return;
    const duration = durationSeconds ?? 0;
    const show = () => {
      const seconds = video.currentTime;
      const total = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : duration;
      setPreview({
        frame: storyboardFrameAt(layout, seconds),
        seconds,
        fraction: total > 0 ? Math.min(1, Math.max(0, seconds / total)) : 0,
      });
    };
    const hide = () => setPreview(null);
    video.addEventListener("seeking", show);
    video.addEventListener("seeked", hide);
    video.addEventListener("emptied", hide);
    return () => {
      video.removeEventListener("seeking", show);
      video.removeEventListener("seeked", hide);
      video.removeEventListener("emptied", hide);
      setPreview(null);
    };
  }, [videoRef, ready, durationSeconds]);

  if (!preview || !plan || !url) return null;

  const column = preview.frame % plan.columns;
  const row = Math.floor(preview.frame / plan.columns);
  const percent = (index: number, count: number) => (count > 1 ? (index / (count - 1)) * 100 : 0);

  return (
    <div
      className={css.preview}
      data-testid="video-scrub-preview"
      style={
        {
          "--scrub-fraction": preview.fraction,
          "--scrub-ar": aspectRatio ?? 16 / 9,
        } as React.CSSProperties
      }
    >
      <div
        className={css.frame}
        data-frame={preview.frame}
        style={{
          backgroundImage: `url("${url}")`,
          backgroundSize: `${plan.columns * 100}% ${plan.rows * 100}%`,
          backgroundPosition: `${percent(column, plan.columns)}% ${percent(row, plan.rows)}%`,
        }}
      />
      <span className={css.time}>{formatTime(preview.seconds)}</span>
    </div>
  );
};
