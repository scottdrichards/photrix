import { useEffect, useRef, useState, type MutableRefObject, type RefObject } from "react";
import { fetchTranscriptSegments } from "../../api";
import type { TranscriptSegment } from "../../api/api.type";
import { logFailure } from "../../logFailure";
import { segmentsToWebVTT } from "./segmentsToWebVTT";

/** A video's transcript: the caption track, the segments for search, and the toggles that show them. */
export const useViewerTranscript = ({
  photoPath,
  photoMediaType,
  videoRef,
  playbackOperationIdRef,
}: {
  photoPath: string | null;
  photoMediaType: string | null;
  videoRef: RefObject<HTMLVideoElement | null>;
  playbackOperationIdRef: MutableRefObject<string | null>;
}) => {
  const [showCaptions, setShowCaptions] = useState(false);
  const [transcriptTrackUrl, setTranscriptTrackUrl] = useState<string | null>(null);
  // The transcript itself, for finding where something is said (feedback #169).
  const [transcriptSegments, setTranscriptSegments] = useState<TranscriptSegment[]>([]);
  const [showTranscriptSearch, setShowTranscriptSearch] = useState(false);
  const captionBlobUrlRef = useRef<string | null>(null);

  // Reset captions for the new item.
  useEffect(() => {
    if (captionBlobUrlRef.current) {
      URL.revokeObjectURL(captionBlobUrlRef.current);
      captionBlobUrlRef.current = null;
    }
    setTranscriptTrackUrl(null);
    setTranscriptSegments([]);
    setShowTranscriptSearch(false);
    setShowCaptions(false);
  }, [photoPath]);

  // Fetch transcript segments for videos
  useEffect(() => {
    if (!photoPath || photoMediaType !== "video") return;

    const abortController = new AbortController();

    fetchTranscriptSegments(
      photoPath,
      abortController.signal,
      playbackOperationIdRef.current ?? undefined,
    )
      .then((segments) => {
        if (segments.length === 0) return;
        setTranscriptSegments(segments);
        const vtt = segmentsToWebVTT(segments);
        const blob = new Blob([vtt], { type: "text/vtt" });
        const url = URL.createObjectURL(blob);
        captionBlobUrlRef.current = url;
        setTranscriptTrackUrl(url);
      })
      // Without a transcript the caption button stays hidden.
      .catch(logFailure("viewer.transcript.failed", "Could not load the video transcript"));

    return () => {
      abortController.abort();
    };
  }, [photoPath, photoMediaType, playbackOperationIdRef]);

  // Sync caption track mode with showCaptions toggle
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const track = video.textTracks[0];
    if (!track) return;
    track.mode = showCaptions ? "showing" : "hidden";
  }, [showCaptions, transcriptTrackUrl, videoRef]);

  return {
    showCaptions,
    setShowCaptions,
    transcriptTrackUrl,
    transcriptSegments,
    showTranscriptSearch,
    setShowTranscriptSearch,
  };
};
