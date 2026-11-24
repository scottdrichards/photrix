import type { RefObject } from "react";
import type { PhotoItem } from "../../api";
import type { PhotoPersonFace } from "../../api/api.type";
import { photoViewTransitionName } from "../viewTransition";
import { playVideo } from "../playVideo";
import type { NamedFace } from "./FaceOverlay";
import { PlaybackBottleneckBadge } from "./PlaybackBottleneckBadge";
import { TranscriptSearch } from "./TranscriptSearch";
import type { useVideoPlayback } from "./useVideoPlayback";
import type { useViewerTranscript } from "./useViewerTranscript";
import { VideoFaceStrip } from "./VideoFaceStrip";
import { VideoLoadingOverlay } from "./VideoLoadingOverlay";
import { VideoPeopleTimeline } from "./VideoPeopleTimeline";
import { VideoScrubPreview } from "./VideoScrubPreview";
import { videoTimelineRows } from "./videoPeople";
import css from "./FullscreenViewer.module.css";

// The people timeline under a video: its rows are this tall, and past this many
// it scrolls rather than squeezing the video further.
const PEOPLE_TIMELINE_ROW_PX = 28;
const PEOPLE_TIMELINE_PADDING_PX = 24;
const PEOPLE_TIMELINE_MAX_ROWS = 4;
// The strip of nameable face crops above the timeline (feedback #177).
const VIDEO_FACE_STRIP_PX = 72;

type Props = {
  photo: PhotoItem;
  videoRef: RefObject<HTMLVideoElement | null>;
  video: ReturnType<typeof useVideoPlayback>;
  transcript: ReturnType<typeof useViewerTranscript>;
  /** This video's faces; empty until its own fetch has landed. */
  faces: PhotoPersonFace[];
  showFaces: boolean;
  /** A naming panel is open: it takes the timeline's place. */
  naming: boolean;
  readOnly: boolean;
  onPickFace: (face: NamedFace) => void;
};

/** The video player with its overlays, the status badge and the people timeline under it. */
export const ViewerVideo = ({
  photo,
  videoRef,
  video,
  transcript,
  faces,
  showFaces,
  naming,
  readOnly,
  onPickFace,
}: Props) => {
  const { videoStatus, playback, bottleneck, retry, activeLevelHeight, videoAspectRatio, setVideoAspectRatio } = video;
  const { transcriptTrackUrl, showCaptions, setShowCaptions, transcriptSegments } = transcript;

  // Who is in this video and when.
  const peopleInVideo = videoTimelineRows(faces);
  // Feedback #173: the faces button shows and hides this timeline, hidden
  // until asked for, as it shows and hides face boxes on a photo.
  const showPeopleTimeline = showFaces && peopleInVideo.length > 0;
  // Feedback #177: with the timeline, the video's faces as crops to name.
  const showVideoFaceStrip = showPeopleTimeline && !readOnly;
  const peopleTimelinePx = showPeopleTimeline
    ? PEOPLE_TIMELINE_PADDING_PX +
      Math.min(peopleInVideo.length, PEOPLE_TIMELINE_MAX_ROWS) * PEOPLE_TIMELINE_ROW_PX +
      (showVideoFaceStrip ? VIDEO_FACE_STRIP_PX : 0)
    : 0;
  const seekVideo = (ms: number) => {
    const el = videoRef.current;
    if (!el) return;
    el.currentTime = ms / 1000;
    // An autoplay refusal is fine: the seek itself still happened.
    playVideo(el);
  };

  return (
    <>
      <div
        className={css.videoWrapper}
        // Same name as this photo's grid tile (see
        // ThumbnailGrid) so the View Transitions API morphs the
        // clicked thumbnail into this wrapper instead of a hard
        // cut — the "expand in place" open feedback #77 asked for.
        style={
          {
            ...(videoAspectRatio
              ? {
                  aspectRatio: videoAspectRatio,
                  "--video-ar": videoAspectRatio,
                }
              : {}),
            viewTransitionName: photoViewTransitionName(photo.path),
            "--people-h": `${peopleTimelinePx}px`,
          } as React.CSSProperties
        }
      >
        <video
          ref={videoRef}
          key={photo.path}
          controls
          className={css.videoMedia}
          poster={photo.previewUrl}
          preload="metadata"
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            if (v.videoWidth && v.videoHeight) {
              setVideoAspectRatio(v.videoWidth / v.videoHeight);
            }
          }}
        >
          <track
            key={transcriptTrackUrl ?? "none"}
            kind="captions"
            src={transcriptTrackUrl ?? "data:,"}
            label={transcriptTrackUrl ? "Transcript" : "Captions not provided"}
            default={Boolean(transcriptTrackUrl) && showCaptions}
          />
          Your browser does not support HTML video playback.
        </video>
        {transcript.showTranscriptSearch && transcriptSegments.length > 0 && (
          <TranscriptSearch
            segments={transcriptSegments}
            onSeek={(seconds) => {
              // Show the line that was searched for as it plays.
              setShowCaptions(true);
              seekVideo(seconds * 1000);
            }}
            onClose={() => transcript.setShowTranscriptSearch(false)}
          />
        )}
        <VideoLoadingOverlay state={playback} onRetry={retry} />
        <VideoScrubPreview
          videoRef={videoRef}
          path={photo.path}
          durationSeconds={photo.metadata?.duration}
          aspectRatio={videoAspectRatio}
        />
        {/* Feedback #185: never the same key as the <video>, its
            sibling. Two children keyed by one path broke
            reconciliation, so "next" left the old video on screen. */}
        <PlaybackBottleneckBadge key={`bottleneck:${photo.path}`} report={bottleneck} />
      </div>
      {/* Hidden under an open naming panel, which it would cover. */}
      {videoStatus && !naming && (
        <span className={css.videoBadge} data-testid="video-status">
          {videoStatus === "direct"
            ? "Original"
            : `Streaming${activeLevelHeight ? ` · ${activeLevelHeight}p` : ""}`}
        </span>
      )}
      {/* Naming a face takes the timeline's place; the space stays so
          the video doesn't jump. */}
      {showPeopleTimeline && !naming && (
        <div className={css.videoPeople} style={{ maxHeight: `${peopleTimelinePx}px` }}>
          {showVideoFaceStrip && (
            <VideoFaceStrip photo={photo} faces={faces} onPick={onPickFace} />
          )}
          <VideoPeopleTimeline
            faces={faces}
            durationMs={photo.metadata?.duration ? photo.metadata.duration * 1000 : undefined}
            onSeek={seekVideo}
          />
        </div>
      )}
    </>
  );
};
