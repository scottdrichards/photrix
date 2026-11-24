import { useEffect, useRef, useState } from "react";
import { fetchPeopleFacesForFile, setFaceVerdicts, type PhotoItem } from "../../api";
import type { PhotoPersonFace } from "../../api/api.type";
import { logClientEvent } from "../../diagnostics";
import { logFailure } from "../../logFailure";
import { parseFaceRegions, parseFaceTableBoxes, type NamedFace } from "./FaceOverlay";

/**
 * The open photo's detected faces with their People names, for the overlay,
 * the video people timeline and the "Who is this?" panel.
 */
export const useViewerFaces = (photo: PhotoItem | null) => {
  const [showFaces, setShowFaces] = useState(false);
  const [hasFaceOverlayData, setHasFaceOverlayData] = useState(false);
  const [peopleFaces, setPeopleFaces] = useState<PhotoPersonFace[]>([]);
  // Which file `peopleFaces` belongs to. The list stays in state until the next
  // file's fetch lands, so the video timeline checks it rather than showing the
  // last video's people over this one.
  const [peopleFacesPath, setPeopleFacesPath] = useState<string | null>(null);
  // Which unnamed face's "Who is this?" chip is open, if any (see
  // FaceAssignPanel). Bumping facesRefreshToken re-runs the faces-fetch
  // effect below to pick up a just-saved name/merge without duplicating its
  // fetch logic.
  const [activeFaceAssign, setActiveFaceAssign] = useState<NamedFace | null>(null);
  const [facesRefreshToken, setFacesRefreshToken] = useState(0);

  // These effects re-run when the viewer moves to another photo, not on every
  // new photo object (a rating or tag edit produces one). They key on the path
  // and read anything else through latestPhotoRef.
  const photoPath = photo?.path ?? null;
  const latestPhotoRef = useRef(photo);
  latestPhotoRef.current = photo;

  useEffect(() => {
    const current = latestPhotoRef.current;
    const hasFaceRegions =
      current !== null &&
      current.mediaType !== "video" &&
      parseFaceRegions(current.metadata?.regions).length > 0;
    const hasFaceTableBoxes =
      current !== null &&
      current.mediaType !== "video" &&
      parseFaceTableBoxes(current.metadata?.faceTableBoxes).length > 0;
    setShowFaces(false);
    setHasFaceOverlayData(hasFaceRegions || hasFaceTableBoxes);
    setPeopleFaces([]);
  }, [photoPath]);

  // Fetch the photo's detected faces (with resolved People names) so the face
  // overlay can label each face and link to its person page. facesRefreshToken
  // is bumped after a successful FaceAssignPanel save so a just-named/merged
  // face's label updates immediately, without a second copy of this fetch.
  // Videos too: their faces carry when each person is on screen, which the
  // people timeline under the player draws.
  useEffect(() => {
    if (!photoPath) return;

    const abortController = new AbortController();
    fetchPeopleFacesForFile(photoPath, abortController.signal)
      .then((faces) => {
        setPeopleFaces(faces);
        setPeopleFacesPath(photoPath);
      })
      // Names are an enhancement: without them the overlay shows the metadata boxes.
      .catch(logFailure("viewer.faces.failed", "Could not load face names for the viewer"));

    return () => abortController.abort();
  }, [photoPath, facesRefreshToken]);

  // Closes any open "Who is this?" panel when the viewer moves to a
  // different photo, rather than leaving it open against the wrong face.
  useEffect(() => {
    setActiveFaceAssign(null);
  }, [photoPath]);

  const refreshFaces = () => setFacesRefreshToken((token) => token + 1);

  // Feedback #145: "this isn't {name}" from the viewer. A rejected verdict
  // pulls the face out of that person, and the refetch drops it from the
  // overlay (only clustered faces come back). Saying who it *is* instead is the
  // name button -> FaceAssignPanel's change mode (feedback #160).
  const handleRejectFace = (face: NamedFace) => {
    setFaceVerdicts([face.faceId], "rejected")
      .then(refreshFaces)
      .catch((error: unknown) => {
        logClientEvent({
          level: "warn",
          event: "faces.reject.failed",
          message: `Could not remove ${face.name ?? "face"} from ${photo?.path ?? "photo"}`,
          data: { faceId: face.faceId, error: String(error) },
        });
      });
  };

  return {
    showFaces,
    setShowFaces,
    hasFaceOverlayData,
    peopleFaces,
    peopleFacesPath,
    activeFaceAssign,
    setActiveFaceAssign,
    refreshFaces,
    handleRejectFace,
  };
};
