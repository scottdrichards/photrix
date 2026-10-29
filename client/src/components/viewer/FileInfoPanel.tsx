import type { PhotoItem } from "../../api";
import { cx } from "../../cx";
import { isSharedView } from "../../hooks/useShareFilter";
import { DescriptionEditor } from "../DescriptionEditor";
import css from "../FullscreenViewer.module.css";
import { MiniMap } from "../MiniMap";
import {
  formatAperture,
  formatDuration,
  formatFileSize,
  formatFocalLength,
  formatShutterSpeed,
} from "./photoInfoFormat";
import type { useAiDescription } from "./useAiDescription";

const READ_ONLY = isSharedView();

type FileInfoPanelProps = {
  photo: PhotoItem;
  aiDescription: ReturnType<typeof useAiDescription>;
  onSaveDescription: (next: string) => void;
  /** Opens a folder in the library (`a/b/`). Absent: the path is plain text. */
  onOpenFolder?: (folderPath: string) => void;
};

/**
 * The file's path with every folder as a link to that folder (feedback #164),
 * so a photo found through search or a filter can be seen among its neighbours.
 */
const FolderPath = ({
  path,
  onOpenFolder,
}: {
  path: string;
  onOpenFolder?: (folderPath: string) => void;
}) => {
  // Library paths are rooted ("/2022/04/x.jpg") but filter paths are not
  // ("2022/04/"): a leading slash would build a "//2022/04" URL.
  const rooted = path.startsWith("/");
  const parts = path.replace(/^\/+/, "").split("/");
  const fileName = parts.pop() ?? "";
  if (!onOpenFolder || parts.length === 0) return <>{path}</>;
  return (
    <>
      {rooted && "/"}
      {parts.map((part, i) => {
        const folderPath = `${parts.slice(0, i + 1).join("/")}/`;
        return (
          <span key={folderPath}>
            <button
              type="button"
              className={css.infoPathLink}
              title={`Open folder ${folderPath}`}
              onClick={() => onOpenFolder(folderPath)}
            >
              {part}
            </button>
            /
          </span>
        );
      })}
      <span>{fileName}</span>
    </>
  );
};

/** The viewer's side panel: description, AI description, camera, capture settings, file details. */
export const FileInfoPanel = ({
  photo,
  aiDescription,
  onSaveDescription,
  onOpenFolder,
}: FileInfoPanelProps) => {
  const meta = photo.metadata;
  const { stored: storedAiDescription, description, retry } = aiDescription;
  return (
      <aside className={css.infoSidebar} aria-label="File info panel">
        <h3 className={css.infoTitle}>File info</h3>

        {/* Human-authored caption: seeded from the file's embedded EXIF/IPTC/XMP
            caption if present, and editable in-app (DB-only, the file itself is
            never modified) — same overlay pattern as the star rating/tags below. */}
        <h4 className={css.infoSubtitle}>Description</h4>
        {READ_ONLY ? (
          Boolean(meta?.description) && (
            <p className={css.infoDescription}>{String(meta?.description)}</p>
          )
        ) : (
          <DescriptionEditor
            key={photo.path}
            value={typeof meta?.description === "string" ? meta.description : ""}
            onSave={onSaveDescription}
          />
        )}

        {/* AI-generated description (feedback #148): stored, or being
            written right now — see the streamPhotoDescription effect. */}
        {photo.mediaType !== "video" && (
          <>
            <h4 className={css.infoSubtitle}>AI description</h4>
            {storedAiDescription ? (
              <p className={cx(css.infoDescription, css.infoDescriptionLong)}>
                {storedAiDescription}
              </p>
            ) : description?.path === photo.path && description.status === "error" ? (
              <>
                <p className={css.infoEmpty}>
                  {description.text
                    ? `${description.text.trim()}…`
                    : "Couldn't write a description."}
                </p>
                <button
                  type="button"
                  className={css.infoDescriptionRetry}
                  onClick={retry}
                >
                  Retry
                </button>
              </>
            ) : description?.path === photo.path && description.text ? (
              <p
                className={cx(
                  css.infoDescription,
                  css.infoDescriptionLong,
                  description.status === "writing" && css.infoDescriptionWriting,
                )}
                aria-busy={description.status === "writing"}
              >
                {description.status === "done"
                  ? description.text
                  : description.text.trimStart()}
              </p>
            ) : (
              <p className={css.infoEmpty} aria-busy="true">
                Writing a description…
              </p>
            )}
          </>
        )}

        {/* Camera */}
        {Boolean(meta?.cameraMake || meta?.cameraModel || meta?.lens) && (
          <>
            <h4 className={css.infoSubtitle}>Camera</h4>
            <dl className={css.infoList}>
              {Boolean(meta?.cameraMake || meta?.cameraModel) && (
                <div className={css.infoRow}>
                  <dt>Camera</dt>
                  <dd>
                    {[meta?.cameraMake, meta?.cameraModel]
                      .filter(Boolean)
                      .join(" ")}
                  </dd>
                </div>
              )}
              {Boolean(meta?.lens) && (
                <div className={css.infoRow}>
                  <dt>Lens</dt>
                  <dd>{String(meta?.lens)}</dd>
                </div>
              )}
            </dl>
          </>
        )}

        {/* Capture settings */}
        {(meta?.aperture != null ||
          meta?.exposureTime != null ||
          meta?.iso != null ||
          meta?.focalLength != null ||
          meta?.flash != null ||
          meta?.whiteBalance != null ||
          meta?.subjectDistance != null) && (
          <>
            <h4 className={css.infoSubtitle}>Capture</h4>
            <dl className={css.infoList}>
              {meta.aperture != null && (
                <div className={css.infoRow}>
                  <dt>Aperture</dt>
                  <dd>{formatAperture(meta.aperture)}</dd>
                </div>
              )}
              {meta.exposureTime != null && (
                <div className={css.infoRow}>
                  <dt>Shutter Speed</dt>
                  <dd>{formatShutterSpeed(meta.exposureTime)}</dd>
                </div>
              )}
              {meta.iso != null && (
                <div className={css.infoRow}>
                  <dt>ISO</dt>
                  <dd>{String(meta.iso)}</dd>
                </div>
              )}
              {meta.focalLength != null && (
                <div className={css.infoRow}>
                  <dt>Focal Length</dt>
                  <dd>{formatFocalLength(meta.focalLength)}</dd>
                </div>
              )}
              {meta.flash != null && (
                <div className={css.infoRow}>
                  <dt>Flash</dt>
                  <dd>{meta.flash ? "Fired" : "Did not fire"}</dd>
                </div>
              )}
              {meta.whiteBalance != null && (
                <div className={css.infoRow}>
                  <dt>White Balance</dt>
                  <dd>{String(meta.whiteBalance)}</dd>
                </div>
              )}
              {meta.subjectDistance != null && (
                <div className={css.infoRow}>
                  <dt>Subject Distance</dt>
                  <dd>{Number(meta.subjectDistance).toFixed(2)} m</dd>
                </div>
              )}
            </dl>
          </>
        )}

        {/* Derived photo-ready quality aggregate (see server's
            photoQuality.ts): worst-scoring detected face's
            smiling/eyes-open/in-focus/well-exposed attributes. Shown
            only when at least one face has been scored — absent
            entirely (not "0%") otherwise, since null means "no
            signal" rather than "bad". Informational only: this never
            sets or suggests a star rating. */}
        {meta?.photoQualityScore != null && (
          <>
            <h4 className={css.infoSubtitle}>Photo quality</h4>
            <dl className={css.infoList}>
              <div className={css.infoRow}>
                <dt>Quality</dt>
                <dd>{Math.round(meta.photoQualityScore * 100)}%</dd>
              </div>
            </dl>
          </>
        )}

        {/* File details */}
        <h4 className={css.infoSubtitle}>File</h4>
        <dl className={css.infoList}>
          <div className={css.infoRow}>
            <dt>Filename</dt>
            <dd>{photo.name}</dd>
          </div>
          <div className={css.infoRow}>
            <dt>Path</dt>
            <dd>
              <FolderPath path={photo.path} onOpenFolder={READ_ONLY ? undefined : onOpenFolder} />
            </dd>
          </div>
          {meta?.dateTaken && (
            <div className={css.infoRow}>
              <dt>Date Taken</dt>
              <dd>{new Date(String(meta.dateTaken)).toLocaleString()}</dd>
            </div>
          )}
          {meta?.dimensionWidth != null && meta?.dimensionHeight != null && (
            <div className={css.infoRow}>
              <dt>Dimensions</dt>
              <dd>
                {String(meta.dimensionWidth)} × {String(meta.dimensionHeight)}
              </dd>
            </div>
          )}
          {meta?.sizeInBytes != null && (
            <div className={css.infoRow}>
              <dt>File Size</dt>
              <dd>{formatFileSize(meta.sizeInBytes)}</dd>
            </div>
          )}
          {meta?.mimeType && (
            <div className={css.infoRow}>
              <dt>Type</dt>
              <dd>{String(meta.mimeType)}</dd>
            </div>
          )}
          {meta?.duration != null && (
            <div className={css.infoRow}>
              <dt>Duration</dt>
              <dd>{formatDuration(meta.duration)}</dd>
            </div>
          )}
          {meta?.framerate != null && (
            <div className={css.infoRow}>
              <dt>Frame Rate</dt>
              <dd>{String(meta.framerate)} fps</dd>
            </div>
          )}
          {meta?.videoCodec && (
            <div className={css.infoRow}>
              <dt>Codec</dt>
              <dd>{String(meta.videoCodec)}</dd>
            </div>
          )}
          {meta?.rating != null && (
            <div className={css.infoRow}>
              <dt>Rating</dt>
              <dd>{"★".repeat(Number(meta.rating))}</dd>
            </div>
          )}
          {Array.isArray(meta?.tags) && (meta.tags as string[]).length > 0 && (
            <div className={css.infoRow}>
              <dt>Tags</dt>
              <dd>{(meta.tags as string[]).join(", ")}</dd>
            </div>
          )}
        </dl>

        <MiniMap
          latitude={photo.metadata?.locationLatitude}
          longitude={photo.metadata?.locationLongitude}
        />
      </aside>
  );
};
