import {
  ArrowDownload24Regular,
  ClosedCaption24Regular,
  ClosedCaptionOff24Regular,
  Dismiss24Regular,
  DocumentSearch24Regular,
  ImageEdit24Regular,
  Info24Regular,
  Print24Regular,
  ScanPerson24Regular,
  Share24Regular,
} from "@fluentui/react-icons";
import type { PhotoItem } from "../../api";
import type { useVideoPlayback } from "./useVideoPlayback";
import type { useViewerTranscript } from "./useViewerTranscript";
import css from "./FullscreenViewer.module.css";

type Props = {
  photo: PhotoItem;
  video: Pick<
    ReturnType<typeof useVideoPlayback>,
    "videoStatus" | "hlsLevels" | "manualLevel" | "activeLevelHeight" | "chooseLevel"
  >;
  transcript: ReturnType<typeof useViewerTranscript>;
  showFaces: boolean;
  faceToggleDisabled: boolean;
  onToggleFaces: () => void;
  editMode: boolean;
  onToggleEdit: () => void;
  showFileInfo: boolean;
  onToggleFileInfo: () => void;
  onExport: (mode: "share" | "download") => void;
  onClose: () => void;
};

/** The buttons in the viewer's top-right corner. */
export const ViewerToolbar = ({
  photo,
  video: { videoStatus, hlsLevels, manualLevel, activeLevelHeight, chooseLevel },
  transcript,
  showFaces,
  faceToggleDisabled,
  onToggleFaces,
  editMode,
  onToggleEdit,
  showFileInfo,
  onToggleFileInfo,
  onExport,
  onClose,
}: Props) => (
  <div className={css.topRightActions}>
    {photo.mediaType === "video" && videoStatus === "hls" && hlsLevels.length > 1 && (
      <select
        className={css.qualitySelect}
        value={manualLevel}
        aria-label="Video quality"
        title="Video quality"
        onChange={(e) => chooseLevel(Number(e.target.value))}
      >
        <option value={-1}>{`Auto${activeLevelHeight ? ` (${activeLevelHeight}p)` : ""}`}</option>
        {[...hlsLevels].reverse().map((level) => (
          <option key={level.index} value={level.index}>
            {level.height >= 2160 ? "4K" : `${level.height}p`}
          </option>
        ))}
      </select>
    )}
    <button
      type="button"
      onClick={() => onExport("share")}
      className={css.infoButton}
      aria-label="Share item"
      title="Share item"
    >
      <Share24Regular />
    </button>
    <button
      type="button"
      onClick={() => onExport("download")}
      className={css.infoButton}
      aria-label="Download item"
      title="Download item"
    >
      <ArrowDownload24Regular />
    </button>
    {photo.mediaType !== "video" && (
      <button
        type="button"
        onClick={() => window.print()}
        className={css.infoButton}
        aria-label="Print item"
        title="Print item"
      >
        <Print24Regular />
      </button>
    )}
    {photo.mediaType === "video" && transcript.transcriptSegments.length > 0 && (
      <button
        type="button"
        onClick={() => transcript.setShowTranscriptSearch((current) => !current)}
        className={css.faceButton}
        aria-label="Search captions"
        aria-pressed={transcript.showTranscriptSearch}
        title="Find where something is said"
      >
        <DocumentSearch24Regular />
      </button>
    )}
    {photo.mediaType === "video" && transcript.transcriptTrackUrl && (
      <button
        type="button"
        onClick={() => transcript.setShowCaptions((current) => !current)}
        className={css.faceButton}
        aria-label={transcript.showCaptions ? "Hide captions" : "Show captions"}
        title={transcript.showCaptions ? "Hide captions" : "Show captions"}
      >
        {transcript.showCaptions ? <ClosedCaption24Regular /> : <ClosedCaptionOff24Regular />}
      </button>
    )}
    <button
      type="button"
      onClick={onToggleFaces}
      className={showFaces ? `${css.faceButton} ${css.infoButtonActive}` : css.faceButton}
      aria-pressed={showFaces}
      aria-label={showFaces ? "Hide faces" : "Show faces"}
      title={showFaces ? "Hide faces" : "Show faces"}
      disabled={faceToggleDisabled}
    >
      <ScanPerson24Regular />
    </button>
    {photo.mediaType !== "video" && (
      <button
        type="button"
        onClick={onToggleEdit}
        className={editMode ? `${css.infoButton} ${css.infoButtonActive}` : css.infoButton}
        aria-label={editMode ? "Close editor" : "Edit photo"}
        title={editMode ? "Close editor" : "Edit photo"}
      >
        <ImageEdit24Regular />
      </button>
    )}
    <button
      type="button"
      onClick={onToggleFileInfo}
      className={css.infoButton}
      aria-label={showFileInfo ? "Hide file info" : "Show file info"}
      title={showFileInfo ? "Hide file info" : "Show file info"}
    >
      <Info24Regular />
    </button>
    <button type="button" onClick={onClose} className={css.closeButton} aria-label="Close">
      <Dismiss24Regular />
    </button>
  </div>
);
