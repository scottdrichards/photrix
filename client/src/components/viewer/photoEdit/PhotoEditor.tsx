import { exportEdited } from "./applyPixelAdj";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDownload24Regular,
  Crop24Regular,
  Dismiss24Regular,
  Eye24Regular,
  EyeOff24Regular,
  ImageArrowCounterclockwise24Regular,
  RotateRight24Regular,
  Wand24Regular,
} from "@fluentui/react-icons";
import { getAuthHeaders } from "../../../auth";
import css from "./PhotoEditor.module.css";
import { CropBox } from "./CropBox";
import { Slider } from "./Slider";
import { DEFAULT_ADJ, type EditAdj, isDirty } from "./editAdj";
import { computeAutoAdjustments } from "./deriveAutoAdj";

// ─── Types ─────────────────────────────────────────────────────────────────

function computeAlignCrop(
  rotationDeg: number,
  aspectRatio: number,
): { top: number; right: number; bottom: number; left: number } {
  const θ = Math.abs(rotationDeg * Math.PI / 180);
  if (θ < 0.001) return { top: 0, right: 0, bottom: 0, left: 0 };
  const W = aspectRatio;
  const H = 1;
  const cosT = Math.cos(θ);
  const sinT = Math.sin(θ);
  const cos2 = Math.cos(2 * θ);
  if (cos2 < 0.001) return { top: 49, right: 49, bottom: 49, left: 49 };
  const a = Math.max(0, (W * cosT - H * sinT) / cos2);
  const b = Math.max(0, (H * cosT - W * sinT) / cos2);
  const cropX = Math.max(0, Math.min(49, ((W - a) / (2 * W)) * 100));
  const cropY = Math.max(0, Math.min(49, ((H - b) / (2 * H)) * 100));
  return { top: cropY, right: cropX, bottom: cropY, left: cropX };
}

// ─── Canvas export ─────────────────────────────────────────────────────────

interface PhotoEditorProps {
  photoName: string;
  /** Relative library path — needed for the auto-straighten suggestion call (feedback #66). */
  photoPath?: string;
  photoFullUrl: string;
  imageAspectRatio?: number;
  cropContainerEl?: HTMLElement | null;
  initialAdj?: EditAdj;
  onAdjChange: (adj: EditAdj) => void;
  onClose: () => void;
  onCropActiveChange?: (active: boolean) => void;
}

export function PhotoEditor({
  photoName,
  photoPath,
  photoFullUrl,
  imageAspectRatio = 1,
  cropContainerEl,
  initialAdj,
  onAdjChange,
  onClose,
  onCropActiveChange,
}: PhotoEditorProps) {
  const [adj, setAdj] = useState<EditAdj>(initialAdj ?? DEFAULT_ADJ);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [hideEdits, setHideEdits] = useState(false);
  const [cropActive, setCropActive] = useState(false);
  const [autoApplying, setAutoApplying] = useState(false);
  const [autoError, setAutoError] = useState<string | null>(null);
  // Feedback #66: bounded auto-straighten. Three states rather than two —
  // "nothing tried yet" is silent (no button clutter until asked), "tried,
  // no confident suggestion" gets an explicit message so a click doesn't
  // look like it silently did nothing, and "applying" mirrors the Auto
  // enhance button's own loading state.
  const [straightenState, setStraightenState] = useState<
    "idle" | "loading" | "none-found" | "error"
  >("idle");

  const update = useCallback(<K extends keyof EditAdj>(key: K, val: EditAdj[K]) => {
    setAdj((prev) => ({ ...prev, [key]: val }));
  }, []);

  // Auto-crop when rotation changes to prevent empty corners
  useEffect(() => {
    const effectiveAR = adj.rotate90 % 2 !== 0 ? 1 / imageAspectRatio : imageAspectRatio;
    const crop = computeAlignCrop(adj.rotation, effectiveAR);
    setAdj((prev) => ({
      ...prev,
      cropTop: crop.top,
      cropRight: crop.right,
      cropBottom: crop.bottom,
      cropLeft: crop.left,
    }));
  }, [adj.rotation, adj.rotate90, imageAspectRatio]);

  useEffect(() => {
    onAdjChange(hideEdits ? DEFAULT_ADJ : adj);
  }, [adj, onAdjChange, hideEdits]);

  useEffect(() => {
    onCropActiveChange?.(cropActive);
  }, [cropActive, onCropActiveChange]);

  const handleExport = async () => {
    setExporting(true);
    setExportError(null);
    try {
      await exportEdited(photoFullUrl, photoName, adj);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExporting(false);
    }
  };

  const handleAuto = async () => {
    setAutoApplying(true);
    setAutoError(null);
    try {
      const auto = await computeAutoAdjustments(photoFullUrl);
      setAdj((prev) => ({ ...prev, ...auto }));
    } catch (e) {
      setAutoError(e instanceof Error ? e.message : "Auto enhance failed");
    } finally {
      setAutoApplying(false);
    }
  };

  const handleAutoStraighten = async () => {
    if (!photoPath) return;
    setStraightenState("loading");
    try {
      const response = await fetch(
        `/api/photos/suggest-rotation?path=${encodeURIComponent(photoPath)}`,
        { headers: getAuthHeaders() },
      );
      const data = (await response.json()) as { angle: number | null };
      if (typeof data.angle === "number") {
        // Prefills the *existing* manual straighten slider — never applied
        // without this explicit click, and the user can still nudge or
        // undo it exactly like a manual straighten.
        setAdj((prev) => ({ ...prev, rotation: data.angle as number }));
        setStraightenState("idle");
      } else {
        setStraightenState("none-found");
      }
    } catch {
      setStraightenState("error");
    }
  };

  const dirty = isDirty(adj);
  const hasCrop = adj.cropTop > 0 || adj.cropRight > 0 || adj.cropBottom > 0 || adj.cropLeft > 0;
  const showCropBox = cropActive && !!cropContainerEl;

  const effectiveAR = adj.rotate90 % 2 !== 0 ? 1 / imageAspectRatio : imageAspectRatio;
  const minCrop = computeAlignCrop(adj.rotation, effectiveAR);
  const totalRotationDeg = adj.rotation + adj.rotate90 * 90;

  const resetCrop = () => {
    setAdj((prev) => ({
      ...prev,
      cropTop: minCrop.top,
      cropRight: minCrop.right,
      cropBottom: minCrop.bottom,
      cropLeft: minCrop.left,
    }));
  };

  return (
    <>
      {showCropBox && cropContainerEl &&
        createPortal(
          <CropBox
            top={adj.cropTop}
            right={adj.cropRight}
            bottom={adj.cropBottom}
            left={adj.cropLeft}
            rotationDeg={totalRotationDeg}
            minCrop={minCrop}
            onChange={(crop) =>
              setAdj((prev) => ({
                ...prev,
                cropTop: crop.top,
                cropRight: crop.right,
                cropBottom: crop.bottom,
                cropLeft: crop.left,
              }))
            }
          />,
          cropContainerEl,
        )}

      <aside className={css.editorPanel} aria-label="Photo editor">
        <div className={css.editorHeader}>
          <span className={css.editorTitle}>Edit Photo</span>
          <div className={css.headerActions}>
            {dirty && (
              <button
                type="button"
                className={css.hideEditsBtn}
                title={hideEdits ? "Show edits" : "Compare with original"}
                onClick={() => setHideEdits((v) => !v)}
              >
                {hideEdits ? <EyeOff24Regular /> : <Eye24Regular />}
              </button>
            )}
            {dirty && (
              <button
                type="button"
                className={css.resetAllBtn}
                onClick={() => { setAdj(DEFAULT_ADJ); setHideEdits(false); }}
                title="Reset all adjustments"
              >
                <ImageArrowCounterclockwise24Regular />
                Reset
              </button>
            )}
            <button
              type="button"
              className={css.closeBtn}
              onClick={onClose}
              aria-label="Close editor"
              title="Done editing"
            >
              <Dismiss24Regular />
            </button>
          </div>
        </div>

        <div className={css.editorBody}>
          <div className={css.autoRow}>
            <button
              type="button"
              className={css.autoBtn}
              onClick={handleAuto}
              disabled={autoApplying}
              title="Automatically balance color and tone (white balance, exposure, contrast, vibrance)"
            >
              <Wand24Regular />
              {autoApplying ? "Analyzing…" : "Auto"}
            </button>
            {autoError && <p className={css.autoError}>{autoError}</p>}
            {photoPath && (
              <button
                type="button"
                className={css.autoBtn}
                onClick={handleAutoStraighten}
                disabled={straightenState === "loading"}
                title="Suggest a level rotation, only when a strong horizon/structural line is detected (feedback #66) — never forced"
              >
                <RotateRight24Regular />
                {straightenState === "loading" ? "Checking…" : "Auto Straighten"}
              </button>
            )}
            {straightenState === "none-found" && (
              <p className={css.autoError}>No confident horizon line found — nothing changed.</p>
            )}
            {straightenState === "error" && (
              <p className={css.autoError}>{"Couldn't check for a horizon line."}</p>
            )}
          </div>

          <section className={css.section}>
            <h4 className={css.sectionTitle}>Light</h4>
            <Slider label="Exposure" value={adj.exposure} min={-100} max={100} onChange={(v) => update("exposure", v)} />
            <Slider label="Contrast" value={adj.contrast} min={-100} max={100} onChange={(v) => update("contrast", v)} />
            <Slider label="Highlights" value={adj.highlights} min={-100} max={100} onChange={(v) => update("highlights", v)} />
            <Slider label="Shadows" value={adj.shadows} min={-100} max={100} onChange={(v) => update("shadows", v)} />
          </section>

          <section className={css.section}>
            <h4 className={css.sectionTitle}>Color</h4>
            <Slider label="Saturation" value={adj.saturation} min={-100} max={100} onChange={(v) => update("saturation", v)} />
            <Slider label="Vibrance" value={adj.vibrance} min={-100} max={100} onChange={(v) => update("vibrance", v)} />
            <Slider label="Temperature" value={adj.temperature} min={-100} max={100} onChange={(v) => update("temperature", v)} />
            <Slider label="Tint" value={adj.tint} min={-100} max={100} onChange={(v) => update("tint", v)} />
          </section>

          <section className={css.section}>
            <h4 className={css.sectionTitle}>Detail</h4>
            <Slider label="Clarity" value={adj.clarity} min={0} max={100} onChange={(v) => update("clarity", v)} />
            <Slider label="Dehaze" value={adj.dehaze} min={-100} max={100} onChange={(v) => update("dehaze", v)} />
            <Slider label="Sharpness" value={adj.sharpness} min={0} max={100} onChange={(v) => update("sharpness", v)} />
          </section>

          <section className={css.section}>
            <h4 className={css.sectionTitle}>Effects</h4>
            <Slider
              label="Vignette"
              value={adj.vignette}
              min={-100}
              max={100}
              onChange={(v) => update("vignette", v)}
            />
          </section>

          <section className={css.section}>
            <h4 className={css.sectionTitle}>Transform</h4>
            <Slider
              label="Align"
              value={adj.rotation}
              min={-45}
              max={45}
              step={0.5}
              onChange={(v) => update("rotation", v)}
            />
            <div className={css.buttonRow}>
              <button
                type="button"
                className={css.transformBtn}
                onClick={() => update("rotate90", (adj.rotate90 + 1) % 4)}
                title="Rotate 90° clockwise"
              >
                <RotateRight24Regular /> Rotate CW
              </button>
            </div>
          </section>

          <section className={css.section}>
            <h4 className={css.sectionTitle}>
              <Crop24Regular style={{ verticalAlign: "middle", marginRight: 4 }} />
              Crop
              <button
                type="button"
                className={`${css.cropToggleBtn} ${cropActive ? css.cropToggleBtnActive : ""}`}
                onClick={() => setCropActive((v) => !v)}
                title={cropActive ? "Hide crop box" : "Show crop box"}
              >
                {cropActive ? "Done" : "Edit"}
              </button>
            </h4>
            {showCropBox ? (
              <p className={css.cropHint}>Drag the handles on the image to adjust crop.</p>
            ) : (
              <p className={css.cropHint}>
                {cropContainerEl
                  ? "Click Edit to adjust crop, or use Align to auto-crop."
                  : "Crop box appears on the image when editing."}
              </p>
            )}
            {hasCrop && (
              <button
                type="button"
                className={css.resetCropBtn}
                onClick={resetCrop}
                title="Reset to minimum crop required by alignment"
              >
                Reset crop
              </button>
            )}
          </section>
        </div>

        <div className={css.editorFooter}>
          {exportError && <p className={css.exportError}>{exportError}</p>}
          <button
            type="button"
            className={css.exportBtn}
            onClick={handleExport}
            disabled={exporting || !dirty}
            title={dirty ? "Download edited JPEG at full resolution" : "Make adjustments first"}
          >
            <ArrowDownload24Regular />
            {exporting ? "Exporting…" : "Download Edited"}
          </button>
        </div>
      </aside>
    </>
  );
}
