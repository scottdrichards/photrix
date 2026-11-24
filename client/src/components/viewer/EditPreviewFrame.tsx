import type { ReactNode } from "react";
import type { PhotoItem } from "../../api";
import type { usePhotoEditSession } from "./usePhotoEditSession";
import css from "./FullscreenViewer.module.css";

type Props = {
  photo: PhotoItem;
  edit: ReturnType<typeof usePhotoEditSession>;
  photoAspectRatio: number;
  zoomStyle: React.CSSProperties;
  isZoomed: boolean;
  onPhotoClick: (e: React.MouseEvent<HTMLElement>) => void;
  onPhotoWheel: (e: React.WheelEvent<HTMLElement>) => void;
  /** The source image reported its size: the frame and the loaded flag follow it. */
  onSourceLoaded: (aspectRatio: number) => void;
  /** The face overlay, when faces are showing. */
  children?: ReactNode;
};

/** The live edit preview: the photo drawn on a canvas with the adjustments applied, under the crop overlay. */
export const EditPreviewFrame = ({
  photo,
  edit,
  photoAspectRatio,
  zoomStyle,
  isZoomed,
  onPhotoClick,
  onPhotoWheel,
  onSourceLoaded,
  children,
}: Props) => {
  const { canvasAdj, previewImgLoaded, previewImgRef, previewCanvasRef } = edit;
  const editTotalDeg = canvasAdj.rotation + canvasAdj.rotate90 * 90;
  const editClipPath =
    canvasAdj.cropTop === 0 && canvasAdj.cropRight === 0 &&
    canvasAdj.cropBottom === 0 && canvasAdj.cropLeft === 0
      ? "none"
      : `inset(${canvasAdj.cropTop}% ${canvasAdj.cropRight}% ${canvasAdj.cropBottom}% ${canvasAdj.cropLeft}%)`;

  return (
    <div
      className={css.photoFrame}
      style={
        {
          ...zoomStyle,
          "--photo-ar": String(photoAspectRatio),
        } as React.CSSProperties
      }
    >
      {/* Thumbnail shown until canvas is ready */}
      <div
        className={css.thumbnailClip}
        aria-hidden="true"
        style={{ opacity: previewImgLoaded ? 0 : 1 }}
      >
        <div
          className={css.thumbnailUnderlay}
          style={{ backgroundImage: `url("${photo.thumbnailUrl}")` }}
        />
      </div>
      {/* Hidden source image for canvas drawing */}
      <img
        ref={previewImgRef}
        src={photo.fullUrl}
        alt=""
        style={{ display: "none" }}
        onLoad={() => {
          const img = previewImgRef.current;
          if (!img) return;
          edit.setPreviewImgLoaded(true);
          if (img.naturalWidth > 0 && img.naturalHeight > 0) {
            onSourceLoaded(img.naturalWidth / img.naturalHeight);
          }
        }}
      />
      <canvas
        ref={previewCanvasRef}
        className={isZoomed ? `${css.photoMedia} ${css.zoomedMedia}` : css.photoMedia}
        onClick={onPhotoClick}
        onWheel={onPhotoWheel}
        style={{
          ...zoomStyle,
          opacity: previewImgLoaded ? 1 : 0,
          "--edit-rotate-deg": `${editTotalDeg}deg`,
          "--edit-flip-x": canvasAdj.flipH ? -1 : 1,
          "--edit-flip-y": canvasAdj.flipV ? -1 : 1,
          "--edit-clip-path": editClipPath,
        } as React.CSSProperties}
      />
      {children}
      <div ref={edit.setCropContainerEl} className={css.cropOverlayContainer} />
    </div>
  );
};
