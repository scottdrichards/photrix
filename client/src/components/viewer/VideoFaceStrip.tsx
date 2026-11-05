import type { PhotoItem } from "../../api";
import type { PhotoPersonFace } from "../../api/types";
import { FaceCropImage } from "../people/FaceCropImage";
import type { NamedFace } from "./FaceOverlay";
import css from "./VideoFaceStrip.module.css";

const firstSeenMs = (face: PhotoPersonFace): number =>
  face.appearances?.[0]?.startMs ?? face.frameTimeMs ?? Number.POSITIVE_INFINITY;

/**
 * One face per person, in the order they first appear. The video pass stores
 * one face per person per video, but a person it split into several tracks
 * (later merged by clustering) has several; the first one seen stands for them.
 */
export const videoFaceTiles = (faces: readonly PhotoPersonFace[]): PhotoPersonFace[] => {
  const byPerson = new Map<string, PhotoPersonFace>();
  for (const face of [...faces].sort((a, b) => firstSeenMs(a) - firstSeenMs(b))) {
    if (!byPerson.has(face.personId)) byPerson.set(face.personId, face);
  }
  return [...byPerson.values()];
};

/** The face, as FaceCropImage wants it: a crop of this video at the face's frame. */
export const videoFaceCrop = (photo: PhotoItem, face: PhotoPersonFace) => ({
  photo,
  box: face.box,
  faceId: face.faceId,
  frameTimeMs: face.frameTimeMs,
});

/**
 * The faces found in a video, as crops you can name (feedback #177). A photo's
 * faces are boxes over the photo; a video's are on frames that may be long
 * gone from the screen, so each is shown as its own crop. Tapping one opens
 * the same panel a photo's face does: name an unnamed person, or say who a
 * misnamed face really is.
 */
export const VideoFaceStrip = ({
  photo,
  faces,
  onPick,
}: {
  photo: PhotoItem;
  faces: readonly PhotoPersonFace[];
  onPick: (face: NamedFace) => void;
}) => {
  const tiles = videoFaceTiles(faces);
  if (tiles.length === 0) return null;
  return (
    <div className={css.strip} role="group" aria-label="Faces in this video">
      {tiles.map((face) => {
        const label = face.name ? `${face.name}: not them?` : "Who is this?";
        return (
          <button
            key={face.faceId}
            type="button"
            className={face.name ? css.tile : `${css.tile} ${css.unnamed}`}
            aria-label={label}
            title={label}
            onClick={(event) => {
              // The viewer's container click toggles its chrome.
              event.stopPropagation();
              onPick(face);
            }}
          >
            <FaceCropImage
              className={css.crop}
              face={videoFaceCrop(photo, face)}
              size={96}
              alt=""
              loading="lazy"
            />
            <span className={css.name} aria-hidden="true">
              {face.name ?? "?"}
            </span>
          </button>
        );
      })}
    </div>
  );
};
