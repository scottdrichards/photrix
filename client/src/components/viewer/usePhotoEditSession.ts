import { useEffect, useId, useRef, useState } from "react";
import type { PhotoItem } from "../../api";
import { logFailure } from "../../logFailure";
import { attemptSync } from "../../result";
import { type EditAdj, DEFAULT_ADJ } from "./photoEdit/editAdj";
import { drawEditPreview } from "./photoEdit/drawEditPreview";

/**
 * The state of editing the open photo: whether the editor is open, the saved
 * adjustments (read from the photo's metadata), the live ones being previewed,
 * and the canvas the preview is drawn on.
 */
export const usePhotoEditSession = (photo: PhotoItem | null) => {
  const [editMode, setEditMode] = useState(false);
  const [cropActive, setCropActive] = useState(false);
  const [canvasAdj, setCanvasAdj] = useState<EditAdj>(DEFAULT_ADJ);
  const [previewImgLoaded, setPreviewImgLoaded] = useState(false);
  const previewImgRef = useRef<HTMLImageElement | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewRafRef = useRef<number | null>(null);
  const [savedAdj, setSavedAdj] = useState<EditAdj>(DEFAULT_ADJ);
  const latestAdjRef = useRef<EditAdj>(DEFAULT_ADJ);
  const rawSavedSvgId = useId();
  const savedSvgId = `pev-${rawSavedSvgId.replace(/:/g, "")}`;
  const [cropContainerEl, setCropContainerEl] = useState<HTMLDivElement | null>(null);

  // Re-runs when the viewer moves to another photo, not on every new photo
  // object (a rating or tag edit produces one): keyed on the path, with
  // anything else read through latestPhotoRef.
  const photoPath = photo?.path ?? null;
  const latestPhotoRef = useRef(photo);
  latestPhotoRef.current = photo;

  useEffect(() => {
    const current = latestPhotoRef.current;
    setEditMode(false);
    setPreviewImgLoaded(false);
    setCanvasAdj(DEFAULT_ADJ);
    const rawEditAdj = current?.metadata?.editAdj;
    const parsed =
      rawEditAdj && typeof rawEditAdj === "string"
        ? attemptSync(() => JSON.parse(rawEditAdj) as EditAdj)
        : null;
    if (parsed && !parsed.ok) {
      logFailure("viewer.edits.unreadable", "Saved photo edits are unreadable; showing the original")(parsed.error);
    }
    const parsedAdj = parsed?.ok ? parsed.value : DEFAULT_ADJ;
    setSavedAdj(parsedAdj);
    latestAdjRef.current = parsedAdj;
  }, [photoPath]);

  useEffect(() => {
    if (!editMode || !previewImgLoaded) return;
    const canvas = previewCanvasRef.current;
    const img = previewImgRef.current;
    if (!canvas || !img) return;
    const adj = canvasAdj;
    if (previewRafRef.current !== null) cancelAnimationFrame(previewRafRef.current);
    previewRafRef.current = requestAnimationFrame(() => {
      previewRafRef.current = null;
      drawEditPreview(canvas, img, adj);
    });
    return () => {
      if (previewRafRef.current !== null) {
        cancelAnimationFrame(previewRafRef.current);
        previewRafRef.current = null;
      }
    };
  }, [canvasAdj, editMode, previewImgLoaded]);

  return {
    editMode,
    setEditMode,
    cropActive,
    setCropActive,
    canvasAdj,
    setCanvasAdj,
    previewImgLoaded,
    setPreviewImgLoaded,
    previewImgRef,
    previewCanvasRef,
    savedAdj,
    setSavedAdj,
    latestAdjRef,
    savedSvgId,
    cropContainerEl,
    setCropContainerEl,
  };
};
