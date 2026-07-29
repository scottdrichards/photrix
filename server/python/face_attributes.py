#!/usr/bin/env python3
"""Per-face attribute derivation: smiling, eyes open, in focus, well exposed.

All four attributes are derived from data the face pipeline **already** produces,
so they add no model and no VRAM:

* InsightFace's `buffalo_l` pack contains `2d106det` (106-point landmarks),
  `1k3d68` (68-point landmarks) and `genderage` alongside the detector and the
  recognition model. `FaceAnalysis.get()` runs every non-detection model in the
  pack on every detected face already — we were simply throwing the landmark
  outputs away. Smile and eye-openness are pure geometry over those points.
* Focus and exposure are numpy statistics over the face crop of the image the
  worker has already decoded.

Total added cost is a few hundred microseconds of CPU per face and zero bytes of
GPU memory.

Every attribute is allowed to return ``None`` meaning "unknown" — a face too
small to judge sharpness on, a profile view where eye geometry is meaningless,
or a landmark model that produced nothing. Callers must treat ``None`` as
genuinely unknown rather than as a failing score.

## Landmark layout

The 106-point markup is undocumented upstream, so the group ranges below were
established empirically against `2d106det.onnx` output (each group's centroid
matches the corresponding 5-point detector keypoint):

    0-32   face contour        72-86    nose
    33-42  eye A (+ centre)    87-96    eye B (+ centre)
    43-51  brow A              97-105   brow B
    52-71  mouth (outer + inner lip)

Only the *group ranges* are relied upon; nothing here depends on the order of
points within a group, because every measurement is an extent along a fitted
axis. That keeps the code robust against a markup ordering we cannot verify from
upstream documentation.

The 68-point fallback follows the standard iBUG-68 markup (verified the same
way): 36-41 / 42-47 eyes, 48-67 mouth.
"""
from __future__ import annotations

import numpy as np

# --------------------------------------------------------------------------- #
# Landmark groups
# --------------------------------------------------------------------------- #

_LM106_GROUPS = {"eyeA": (33, 43), "eyeB": (87, 97), "mouth": (52, 72)}
_LM68_GROUPS = {"eyeA": (36, 42), "eyeB": (42, 48), "mouth": (48, 68)}

# Beyond this absolute yaw (degrees) the face is turned far enough that the far
# eye is foreshortened into a slit and the mouth is seen edge-on; the geometric
# measures stop meaning what they mean head-on, so we report "unknown" instead of
# a confidently wrong score.
MAX_YAW_DEGREES = 45.0

# An eye whose perpendicular extent is this fraction of its corner-to-corner
# extent reads as fully closed / fully open. Calibrated over a sample of this
# library: closed/blinking eyes measured 0.11-0.18, open eyes 0.22-0.44, so the
# ramp sits in the gap and a smile-squint still scores comfortably "open".
EYE_RATIO_CLOSED = 0.155
EYE_RATIO_OPEN = 0.235

# Corner lift (in inter-ocular units) spanning neutral -> clearly smiling.
SMILE_LIFT_NEUTRAL = 0.02
SMILE_LIFT_SMILING = 0.11

# Mouth width (in inter-ocular units) spanning neutral -> clearly smiling.
# Measured neutrals sat at 0.61-0.90, smiles at 0.89-1.11.
SMILE_WIDTH_NEUTRAL = 0.93
SMILE_WIDTH_SMILING = 1.03

# Face crops smaller than this (shorter side, in decoded pixels) carry too few
# samples to tell "out of focus" from "small"; sharpness is reported unknown.
MIN_FOCUS_CROP_PX = 72
# Canonical size the crop is resampled to before the Laplacian, so the sharpness
# measure means "sharp relative to the face" rather than "big".
FOCUS_CANONICAL_PX = 112

# Normalised Laplacian energy (variance of the Laplacian over variance of the
# image) at which a face reads as fully blurred / fully sharp. Calibrated by
# sweeping synthetic Gaussian blur over sharp library faces at the canonical
# size: in-focus faces measured 0.06-0.83 (the spread is skin/hair texture),
# a 1.5px blur dropped them to 0.013-0.09.
FOCUS_ENERGY_BLURRED = 0.012
FOCUS_ENERGY_SHARP = 0.055

# Mean face luma (0-255) that is comfortably exposed, and the distance from that
# band at which exposure scores zero.
EXPOSURE_TARGET_LOW = 85.0
EXPOSURE_TARGET_HIGH = 185.0
EXPOSURE_FALLOFF = 65.0
# Fraction of clipped pixels that costs the full clipping penalty.
EXPOSURE_CLIP_FULL_PENALTY = 0.25


def _clamp01(value: float) -> float:
    return float(min(1.0, max(0.0, value)))


def _ramp(value: float, low: float, high: float) -> float:
    """Linear 0..1 ramp between `low` and `high` (handles high < low)."""
    if high == low:
        return 0.0 if value < low else 1.0
    return _clamp01((value - low) / (high - low))


def _axis_extents(points: np.ndarray) -> tuple[float, float]:
    """Extent of a point cloud along its major and minor principal axes.

    Ordering-free by construction: it only looks at how far the points spread,
    never at which point comes first. For an eye contour the major extent is the
    corner-to-corner width and the minor extent is the lid separation.
    """
    centred = points - points.mean(axis=0)
    # 2x2 covariance; eigenvectors are the principal axes.
    cov = np.cov(centred.T)
    if not np.all(np.isfinite(cov)):
        return 0.0, 0.0
    eigenvalues, eigenvectors = np.linalg.eigh(cov)
    order = np.argsort(eigenvalues)[::-1]
    axes = eigenvectors[:, order]
    projected = centred @ axes
    spans = projected.max(axis=0) - projected.min(axis=0)
    return float(spans[0]), float(spans[1])


def _group(landmarks: np.ndarray, groups: dict, name: str) -> np.ndarray:
    start, end = groups[name]
    return landmarks[start:end, :2]


def _eyes_open_score(landmarks: np.ndarray, groups: dict) -> float | None:
    ratios = []
    for name in ("eyeA", "eyeB"):
        points = _group(landmarks, groups, name)
        if points.shape[0] < 4:
            return None
        major, minor = _axis_extents(points)
        if major <= 1e-6:
            return None
        ratios.append(minor / major)
    # Both eyes must be open for the photo to be "eyes open", so the worse eye
    # decides. This is what makes the attribute catch a mid-blink.
    return _ramp(min(ratios), EYE_RATIO_CLOSED, EYE_RATIO_OPEN)


def _face_axes(landmarks: np.ndarray, groups: dict) -> tuple[np.ndarray, np.ndarray] | None:
    """Unit vectors pointing 'up' the face and across it, from eyes to mouth.

    Deriving the frame from the landmarks themselves (rather than image axes)
    makes every downstream measurement invariant to head roll and to a rotated
    camera.
    """
    eye_centre = np.vstack(
        [_group(landmarks, groups, "eyeA"), _group(landmarks, groups, "eyeB")]
    ).mean(axis=0)
    mouth_centre = _group(landmarks, groups, "mouth").mean(axis=0)
    up = eye_centre - mouth_centre
    length = float(np.linalg.norm(up))
    if length <= 1e-6:
        return None
    up = up / length
    across = np.array([up[1], -up[0]])
    return up, across


def _smile_features(landmarks: np.ndarray, groups: dict) -> tuple[float, float] | None:
    """(corner lift, mouth width) in units of inter-ocular distance.

    A smile pulls the mouth corners outward and upward. Both are measured in the
    face's own frame and against the mouth's own extremes, so nothing here
    depends on the undocumented order of points within the mouth group.

    Corner lift is measured against the vertical *middle of the lips at the
    centre of the mouth*, not against the mouth centroid. That distinction
    matters: an open mouth drags the centroid down towards the lower lip, which
    made open-mouthed grins — the most obviously "photo ready" expression there
    is — score as neutral or worse.
    """
    axes = _face_axes(landmarks, groups)
    if axes is None:
        return None
    up, across = axes

    eye_a = _group(landmarks, groups, "eyeA").mean(axis=0)
    eye_b = _group(landmarks, groups, "eyeB").mean(axis=0)
    interocular = float(np.linalg.norm(eye_a - eye_b))
    if interocular <= 1e-6:
        return None

    mouth = _group(landmarks, groups, "mouth")
    if mouth.shape[0] < 8:
        return None
    relative = mouth - mouth.mean(axis=0)
    horizontal = relative @ across
    vertical = relative @ up

    left_index = int(np.argmin(horizontal))
    right_index = int(np.argmax(horizontal))
    span = float(horizontal[right_index] - horizontal[left_index])
    if span <= 1e-6:
        return None
    width = span / interocular

    # Vertical centre of the lips sampled across the middle fifth of the mouth:
    # midway between the highest and lowest lip point there, which is the lip
    # line for a closed mouth and the middle of the opening for an open one.
    middle = (horizontal[left_index] + horizontal[right_index]) / 2.0
    centre_band = vertical[np.abs(horizontal - middle) < 0.2 * span]
    if centre_band.size == 0:
        return None
    centre_v = (float(centre_band.max()) + float(centre_band.min())) / 2.0

    corner_v = (float(vertical[left_index]) + float(vertical[right_index])) / 2.0
    lift = (corner_v - centre_v) / interocular
    return lift, width


def _smile_score(landmarks: np.ndarray, groups: dict) -> float | None:
    features = _smile_features(landmarks, groups)
    if features is None:
        return None
    lift, width = features
    # Two independent cues, combined with max() rather than a weighted sum,
    # because each one covers the other's blind spot:
    #   - Corner lift catches closed-lip smiles, which barely widen the mouth.
    #   - Mouth width catches broad open-mouthed grins, where the jaw drops far
    #     enough that the corners sit level with (or below) the middle of the
    #     opening and lift alone reads as neutral.
    # Averaging them would let each blind spot veto the other's evidence; taking
    # the stronger cue lets either one carry the call.
    return max(
        _ramp(lift, SMILE_LIFT_NEUTRAL, SMILE_LIFT_SMILING),
        _ramp(width, SMILE_WIDTH_NEUTRAL, SMILE_WIDTH_SMILING),
    )


# --------------------------------------------------------------------------- #
# Crop statistics
# --------------------------------------------------------------------------- #


def _to_gray(rgb: np.ndarray) -> np.ndarray:
    return (
        0.299 * rgb[..., 0].astype(np.float32)
        + 0.587 * rgb[..., 1].astype(np.float32)
        + 0.114 * rgb[..., 2].astype(np.float32)
    )


def _crop_face(rgb: np.ndarray, bbox) -> np.ndarray | None:
    height, width = rgb.shape[:2]
    x1, y1, x2, y2 = (int(round(float(v))) for v in bbox)
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(width, x2), min(height, y2)
    if x2 - x1 < 4 or y2 - y1 < 4:
        return None
    return rgb[y1:y2, x1:x2]


def _resize_gray(gray: np.ndarray, size: int) -> np.ndarray:
    try:
        import cv2

        interpolation = cv2.INTER_AREA if gray.shape[0] > size else cv2.INTER_LINEAR
        return cv2.resize(gray, (size, size), interpolation=interpolation)
    except Exception:  # noqa: BLE001 - cv2 is optional; fall back to PIL
        from PIL import Image

        image = Image.fromarray(np.clip(gray, 0, 255).astype(np.uint8))
        return np.asarray(
            image.resize((size, size), Image.Resampling.BILINEAR), dtype=np.float32
        )


def _laplacian(gray: np.ndarray) -> np.ndarray:
    try:
        import cv2

        return cv2.Laplacian(gray, cv2.CV_32F)
    except Exception:  # noqa: BLE001 - plain numpy 4-neighbour Laplacian
        padded = np.pad(gray, 1, mode="edge")
        return (
            padded[:-2, 1:-1]
            + padded[2:, 1:-1]
            + padded[1:-1, :-2]
            + padded[1:-1, 2:]
            - 4.0 * gray
        )


def _focus_score(crop: np.ndarray) -> float | None:
    """Scale-normalised sharpness of the face crop.

    Resampling to a canonical size first is what makes this mean "sharp for its
    size" instead of "large": a big blurry face and a small blurry face both land
    at the same canonical blur radius. Dividing the Laplacian energy by the
    crop's own intensity variance stops a flat, low-contrast (but sharp) face
    from being reported as blurred.
    """
    if min(crop.shape[:2]) < MIN_FOCUS_CROP_PX:
        # Upsampling a tiny crop manufactures blur that isn't in the photo. Say
        # "unknown" rather than "blurry".
        return None
    gray = _resize_gray(_to_gray(crop), FOCUS_CANONICAL_PX)
    contrast = float(np.var(gray))
    if contrast < 1.0:
        return None
    energy = float(np.var(_laplacian(gray))) / contrast
    return _ramp(energy, FOCUS_ENERGY_BLURRED, FOCUS_ENERGY_SHARP)


def _exposure_score(crop: np.ndarray) -> float | None:
    gray = _to_gray(crop)
    if gray.size == 0:
        return None
    mean = float(np.mean(gray))
    if mean < EXPOSURE_TARGET_LOW:
        band = _ramp(mean, EXPOSURE_TARGET_LOW - EXPOSURE_FALLOFF, EXPOSURE_TARGET_LOW)
    elif mean > EXPOSURE_TARGET_HIGH:
        band = 1.0 - _ramp(
            mean, EXPOSURE_TARGET_HIGH, EXPOSURE_TARGET_HIGH + EXPOSURE_FALLOFF
        )
    else:
        band = 1.0

    total = float(gray.size)
    blown = float(np.count_nonzero(gray >= 250.0)) / total
    crushed = float(np.count_nonzero(gray <= 6.0)) / total
    # Clipped highlights on a face are unrecoverable, so they cost more than
    # crushed shadows (dark hair legitimately reads near zero).
    penalty = 1.0 - min(1.0, blown / EXPOSURE_CLIP_FULL_PENALTY)
    penalty *= 1.0 - 0.5 * min(1.0, crushed / EXPOSURE_CLIP_FULL_PENALTY)
    return _clamp01(band * penalty)


# --------------------------------------------------------------------------- #
# Public entry point
# --------------------------------------------------------------------------- #


def _pick_landmarks(face) -> tuple[np.ndarray, dict] | None:
    """Prefer the dense 2D markup; fall back to the 3D-fitted 68-point one."""
    for key, groups in (
        ("landmark_2d_106", _LM106_GROUPS),
        ("landmark_3d_68", _LM68_GROUPS),
    ):
        try:
            points = face.get(key) if hasattr(face, "get") else None
        except Exception:  # noqa: BLE001
            points = None
        if points is None:
            continue
        array = np.asarray(points, dtype=np.float64)
        if array.ndim != 2 or array.shape[0] < max(end for _, end in groups.values()):
            continue
        return array[:, :2], groups
    return None


def _yaw_degrees(face) -> float | None:
    try:
        pose = face.get("pose") if hasattr(face, "get") else None
    except Exception:  # noqa: BLE001
        pose = None
    if pose is None:
        return None
    pose = np.asarray(pose, dtype=np.float64).ravel()
    if pose.size < 2:
        return None
    return float(abs(pose[1]))


def compute_face_attributes(rgb: np.ndarray, face) -> dict:
    """Derive the four "photo ready" attributes for one detected face.

    `rgb` is the already-decoded full image (H, W, 3) uint8; `face` is the
    InsightFace result object. Any attribute that cannot be judged is omitted
    from the returned dict, which the Node side stores as SQL NULL / "unknown".
    """
    attributes: dict[str, float] = {}

    crop = _crop_face(rgb, face.bbox)
    if crop is not None:
        focus = _focus_score(crop)
        if focus is not None:
            attributes["focus"] = round(focus, 4)
        exposure = _exposure_score(crop)
        if exposure is not None:
            attributes["exposure"] = round(exposure, 4)

    picked = _pick_landmarks(face)
    if picked is None:
        return attributes

    yaw = _yaw_degrees(face)
    if yaw is not None and yaw > MAX_YAW_DEGREES:
        # Turned too far away for eye/mouth geometry to mean anything.
        return attributes

    landmarks, groups = picked
    eyes_open = _eyes_open_score(landmarks, groups)
    if eyes_open is not None:
        attributes["eyesOpen"] = round(eyes_open, 4)
    smile = _smile_score(landmarks, groups)
    if smile is not None:
        attributes["smile"] = round(smile, 4)
    return attributes
