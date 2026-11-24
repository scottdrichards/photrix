import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronLeft48Regular,
  ChevronRight48Regular,
  Live24Filled,
  Live24Regular,
} from "@fluentui/react-icons";
import { consumeLiveOpenIntent } from "../grid/tileMedia/liveOpenIntent";
import { StarRating } from "../StarRating";
import { TagEditor } from "../TagEditor";
import { createClientOperationId, logClientEvent } from "../../diagnostics";
import { FaceOverlay } from "./FaceOverlay";
import { videoFaceCrop } from "./VideoFaceStrip";
import { FaceAssignPanel } from "./FaceAssignPanel";
import { useSelectionContext } from "../selection/SelectionContext";
import { ShareOptionsModal } from "../share/ShareOptionsModal";
import { PhotoEditor } from "./photoEdit/PhotoEditor";
import { computeStyle, isDirty } from "./photoEdit/editAdj";
import { EditSvgDefs } from "./photoEdit/EditSvgDefs";
import { SwipePhotoViewer } from "./SwipePhotoViewer";
import { isSharedView } from "../../hooks/useShareFilter";
import { cx } from "../../cx";
import { photoViewTransitionName } from "../viewTransition";
import css from "./FullscreenViewer.module.css";
import { useVideoPlayback } from "./useVideoPlayback";
import { useAiDescription } from "./useAiDescription";
import { FileInfoPanel } from "./FileInfoPanel";
import { EditPreviewFrame } from "./EditPreviewFrame";
import { ViewerToolbar } from "./ViewerToolbar";
import { ViewerVideo } from "./ViewerVideo";
import { useFolderOpen } from "./useFolderOpen";
import { usePhotoCaptionTitle } from "./usePhotoCaptionTitle";
import { usePhotoEditSession } from "./usePhotoEditSession";
import { usePhotoZoom } from "./usePhotoZoom";
import { useViewerChrome } from "./useViewerChrome";
import { useViewerFaces } from "./useViewerFaces";
import { useViewerNavigation } from "./useViewerNavigation";
import { useViewerTagging } from "./useViewerTagging";
import { useViewerTranscript } from "./useViewerTranscript";
import { videoTimelineRows } from "./videoPeople";

// Star ratings and tags persist to the DB via PATCH, which the server rejects
// for share tokens — so hide the tagging bar entirely in a shared view.
const READ_ONLY = isSharedView();

// Size the photo frame from known metadata dimensions so the cached thumbnail
// placeholder occupies the correct box before the full image reports its size.
const readMetadataAspectRatio = (metadata: Record<string, unknown> | undefined): number => {
  const width = Number(metadata?.dimensionWidth);
  const height = Number(metadata?.dimensionHeight);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return width / height;
  }
  return 1;
};

export function FullscreenViewer() {
  const {
    items = [],
    selected: selectedPhoto,
    setSelected,
    selectNext,
    selectPrevious,
  } = useSelectionContext();
  const photo = selectedPhoto;
  const photoPath = photo?.path ?? null;
  const photoMediaType = photo?.mediaType ?? null;

  const dialogRef = useRef<HTMLDialogElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const playbackOperationIdRef = useRef<string | null>(null);

  const openFolder = useFolderOpen(photo, setSelected);
  useViewerChrome(photo, items, dialogRef);

  const [photoAspectRatio, setPhotoAspectRatio] = useState(1);
  const [fullImageLoaded, setFullImageLoaded] = useState(false);
  const [showLiveVideo, setShowLiveVideo] = useState(false);
  // Opening a photo starts on the still, unless the grid says the user clicked
  // that tile's live badge — then go straight to the motion clip.
  useEffect(() => {
    setShowLiveVideo(consumeLiveOpenIntent(photo?.path));
  }, [photo?.path]);
  const [showFileInfo, setShowFileInfo] = useState(false);
  const aiDescription = useAiDescription(photo, showFileInfo);
  const [exportMode, setExportMode] = useState<"share" | "download" | null>(null);

  const video = useVideoPlayback({ photo, videoRef, playbackOperationIdRef });

  // Runs when the viewer moves to another photo, not on every new photo object
  // (a rating or tag edit produces one): it keys on the path. Each hook below
  // resets its own state the same way; this resets what the viewer itself owns.
  // It must stay above useViewerTranscript, which reads the operation id set here.
  useEffect(() => {
    const current = photo;
    setShowLiveVideo(false);
    setExportMode(null);
    setPhotoAspectRatio(readMetadataAspectRatio(current?.metadata));
    setFullImageLoaded(false);

    if (current?.mediaType === "video") {
      const clientOperationId = createClientOperationId();
      playbackOperationIdRef.current = clientOperationId;
      logClientEvent({
        level: "info",
        event: "video.playback.selected",
        message: `Selected video ${current.path}`,
        clientOperationId,
        data: { path: current.path },
        immediate: true,
      });
      return;
    }

    playbackOperationIdRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photoPath]);

  const edit = usePhotoEditSession(photo);
  const { editMode, setEditMode, savedAdj, savedSvgId } = edit;
  const zoom = usePhotoZoom(photoPath, edit.cropActive);
  const faces = useViewerFaces(photo);
  const transcript = useViewerTranscript({ photoPath, photoMediaType, videoRef, playbackOperationIdRef });
  usePhotoCaptionTitle(photoPath, photoMediaType);
  const { currentRating, currentTags, persistTagging, saveMetadata, metadataSaveError } =
    useViewerTagging(photo, editMode);
  const { handleTouchStart, handleTouchEnd, currentIndex, prevPhoto, nextPhoto } =
    useViewerNavigation({ photo, items, editMode, setEditMode, setSelected, selectNext, selectPrevious });

  const { setCropActive } = edit;
  const { collapseZoom } = zoom;
  const handleCropActiveChange = useCallback(
    (active: boolean) => {
      setCropActive(active);
      if (active) collapseZoom();
    },
    [setCropActive, collapseZoom],
  );

  const handleClose = () => {
    setSelected(null);
  };

  const handleBackdropClick = (e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === dialogRef.current) {
      setSelected(null);
    }
  };

  const handleContainerClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      setSelected(null);
    }
  };

  // The carousel owns swipe navigation for still photos; the container-level
  // swipe fallback stays for video / live-photo / editing.
  const usesSwipeViewer =
    photo != null && photo.mediaType !== "video" && !showLiveVideo && !editMode;

  const videoFaces =
    photo?.mediaType === "video" && faces.peopleFacesPath === photo.path ? faces.peopleFaces : [];
  const faceToggleDisabled =
    photo?.mediaType === "video"
      ? videoTimelineRows(videoFaces).length === 0
      : !faces.hasFaceOverlayData && faces.peopleFaces.length === 0;

  const faceOverlay = photo && faces.showFaces && (
    <FaceOverlay
      regionsRaw={photo.metadata?.regions}
      faceTableBoxesRaw={photo.metadata?.faceTableBoxes}
      aspectRatio={photoAspectRatio}
      namedFaces={faces.peopleFaces}
      onAssignFace={READ_ONLY ? undefined : faces.setActiveFaceAssign}
      onRejectFace={READ_ONLY ? undefined : faces.handleRejectFace}
    />
  );

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
    <dialog
      ref={dialogRef}
      className={css.dialog}
      onClose={handleClose}
      onCancel={handleClose}
      onClick={handleBackdropClick}
    >
      {photo && (
        <>
          {/* SVG filter for saved edits, active in the non-edit view */}
          {isDirty(savedAdj) && !editMode && <EditSvgDefs adj={savedAdj} filterId={savedSvgId} />}
          {exportMode && (
            <ShareOptionsModal
              photos={[photo]}
              mode={exportMode}
              portalRoot={dialogRef.current}
              onClose={() => setExportMode(null)}
            />
          )}
          <div className={css.viewerLayout}>
            {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
            <div
              className={
                editMode && photo.mediaType !== "video"
                  ? cx(css.container, css.containerEditing)
                  : css.container
              }
              onClick={handleContainerClick}
              onTouchStart={usesSwipeViewer ? undefined : handleTouchStart}
              onTouchEnd={usesSwipeViewer ? undefined : handleTouchEnd}
            >
              <ViewerToolbar
                photo={photo}
                video={video}
                transcript={transcript}
                showFaces={faces.showFaces}
                faceToggleDisabled={faceToggleDisabled}
                onToggleFaces={() => faces.setShowFaces((current) => !current)}
                editMode={editMode}
                onToggleEdit={() => {
                  setEditMode((m) => !m);
                  if (!editMode) setShowFileInfo(false);
                }}
                showFileInfo={showFileInfo}
                onToggleFileInfo={() => setShowFileInfo((current) => !current)}
                onExport={setExportMode}
                onClose={() => setSelected(null)}
              />
              {photo.mediaType !== "video" && photo.livePhotoUrl && (
                <button
                  type="button"
                  onClick={() => setShowLiveVideo((v) => !v)}
                  // Feedback #136: this toggled the still/live view with no
                  // visual sign of which one was current -- the icon never
                  // changed, only the (invisible-until-hover) title/aria-label
                  // text did. Filled + an active background when live video
                  // is showing, matching the same on/off pattern the grid's
                  // own live badge already uses.
                  className={`${css.livePhotoButton} ${showLiveVideo ? css.livePhotoButtonActive : ""}`}
                  aria-pressed={showLiveVideo}
                  aria-label={showLiveVideo ? "Show photo" : "Play live photo"}
                  title={showLiveVideo ? "Show photo" : "Play live photo"}
                >
                  {showLiveVideo ? <Live24Filled /> : <Live24Regular />}
                </button>
              )}
              {!editMode && currentIndex > 0 && (
                <button
                  type="button"
                  className={`${css.navButton} ${css.navPrev}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    selectPrevious();
                  }}
                  aria-label="Previous"
                  title="Previous"
                >
                  <ChevronLeft48Regular />
                </button>
              )}
              {!editMode && currentIndex >= 0 && currentIndex < items.length - 1 && (
                <button
                  type="button"
                  className={`${css.navButton} ${css.navNext}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    selectNext();
                  }}
                  aria-label="Next"
                  title="Next"
                >
                  <ChevronRight48Regular />
                </button>
              )}
              {photo.mediaType === "video" ? (
                <ViewerVideo
                  photo={photo}
                  videoRef={videoRef}
                  video={video}
                  transcript={transcript}
                  faces={videoFaces}
                  showFaces={faces.showFaces}
                  naming={Boolean(faces.activeFaceAssign)}
                  readOnly={READ_ONLY}
                  onPickFace={faces.setActiveFaceAssign}
                />
              ) : showLiveVideo && photo.livePhotoUrl ? (
                // Feedback #104: without a poster, the still image
                // disappears the instant this switches from the <img>
                // branch, leaving a blank frame until the live clip has
                // enough data to paint. previewUrl is the same image the
                // still branch was just showing, so this reads as a
                // continuous transition instead of a flash of nothing.
                <video
                  key={photo.livePhotoUrl}
                  src={photo.livePhotoUrl}
                  poster={photo.previewUrl}
                  autoPlay
                  loop
                  playsInline
                  muted
                  // Feedback #136: with no preload hint, some mobile browsers
                  // default to fetching only metadata and don't start
                  // downloading the actual clip until autoplay kicks in --
                  // this is a single clip the user explicitly asked to see
                  // (unlike the grid's ambient previews, which deliberately
                  // preload="none" to avoid fetching clips nobody asked for),
                  // so eagerly fetching it is the right tradeoff here.
                  preload="auto"
                  className={css.media}
                />
              ) : editMode ? (
                <EditPreviewFrame
                  photo={photo}
                  edit={edit}
                  photoAspectRatio={photoAspectRatio}
                  zoomStyle={zoom.zoomStyle}
                  isZoomed={zoom.isZoomed}
                  onPhotoClick={zoom.handlePhotoClick}
                  onPhotoWheel={zoom.handlePhotoWheel}
                  onSourceLoaded={(aspectRatio) => {
                    setPhotoAspectRatio(aspectRatio);
                    setFullImageLoaded(true);
                  }}
                >
                  {faceOverlay}
                </EditPreviewFrame>
              ) : (
                <SwipePhotoViewer
                  photo={photo}
                  prevPhoto={prevPhoto}
                  nextPhoto={nextPhoto}
                  photoAspectRatio={photoAspectRatio}
                  fullImageLoaded={fullImageLoaded}
                  viewTransitionName={photoViewTransitionName(photo.path)}
                  editStyle={isDirty(savedAdj) ? computeStyle(savedAdj, savedSvgId) : undefined}
                  onImageLoad={(img) => {
                    setFullImageLoaded(true);
                    const { naturalWidth, naturalHeight } = img;
                    if (naturalWidth > 0 && naturalHeight > 0) {
                      setPhotoAspectRatio(naturalWidth / naturalHeight);
                    }
                  }}
                  onNext={selectNext}
                  onPrev={selectPrevious}
                  onClose={() => setSelected(null)}
                >
                  {faceOverlay}
                </SwipePhotoViewer>
              )}
              {!editMode && !READ_ONLY && faces.activeFaceAssign && (
                <FaceAssignPanel
                  face={faces.activeFaceAssign}
                  subject={
                    photo.mediaType === "video"
                      ? videoFaceCrop(
                          photo,
                          videoFaces.find((f) => f.faceId === faces.activeFaceAssign?.faceId) ??
                            faces.activeFaceAssign,
                        )
                      : undefined
                  }
                  onClose={() => faces.setActiveFaceAssign(null)}
                  onAssigned={() => {
                    faces.setActiveFaceAssign(null);
                    faces.refreshFaces();
                  }}
                />
              )}
              {!editMode && !READ_ONLY && photo.mediaType !== "video" && !faces.activeFaceAssign && (
                // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
                <div className={css.taggingBar} onClick={(e) => e.stopPropagation()}>
                  <StarRating
                    value={currentRating}
                    onChange={(rating) => persistTagging({ rating })}
                    label="Star rating"
                  />
                  {metadataSaveError && (
                    <span className={css.taggingError} role="alert">
                      {metadataSaveError}
                    </span>
                  )}
                  <span className={css.taggingDivider} aria-hidden="true" />
                  <TagEditor
                    tags={currentTags}
                    onChange={(tags) => persistTagging({ tags })}
                  />
                </div>
              )}
            </div>
            {editMode && photo.mediaType !== "video" && (
              <PhotoEditor
                photoName={photo.name}
                photoPath={photo.path}
                photoFullUrl={photo.fullUrl}
                imageAspectRatio={photoAspectRatio}
                cropContainerEl={edit.cropContainerEl}
                initialAdj={savedAdj}
                onAdjChange={(adj) => { edit.latestAdjRef.current = adj; edit.setCanvasAdj(adj); }}
                onCropActiveChange={handleCropActiveChange}
                onClose={() => {
                  setCropActive(false);
                  const adj = edit.latestAdjRef.current;
                  edit.setSavedAdj(adj);
                  setEditMode(false);
                  if (!READ_ONLY) {
                    saveMetadata([
                      {
                        path: photo.path,
                        patch: { editAdj: isDirty(adj) ? JSON.stringify(adj) : null },
                        shown: {},
                        previous: {},
                      },
                    ]);
                  }
                }}
              />
            )}
            {!editMode && showFileInfo && (
              <FileInfoPanel
                photo={photo}
                aiDescription={aiDescription}
                onOpenFolder={openFolder}
                onSaveDescription={(next) =>
                  persistTagging({ description: next.length > 0 ? next : null })
                }
              />
            )}
          </div>
        </>
      )}
    </dialog>
  );
}
