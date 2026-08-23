"""
Feedback #66 — bounded auto-straighten suggestion.

Research conclusion (see docs/moment-clustering.md/AGENTS.md for the summary
handed back to the user): the user's own proposal — "a high-frequency/depth
map heuristic" — is not how any shipping auto-straighten tool actually works,
and there is no established technique that reliably infers "this photo is
tilted" from frequency content or a monocular depth estimate; both would
readily mistake ordinary texture/perspective for tilt.

What *is* a proven, bounded technique — the one Lightroom's "Auto" angle tool
and Google Photos' auto-straighten both use — is: find the image's most
visually dominant straight edge via a Hough transform, and if (and only if)
one edge is a clear, strong majority vote near-horizontal or near-vertical,
suggest levelling to it. It is NOT reliable on arbitrary photos in general —
a portrait or close-up often has no dominant straight edge at all — which is
exactly why every real implementation (including this one) is confidence-
gated and silent rather than forced: no strong single-line majority, no
suggestion, ever.

Standalone script (own subprocess per call, like ffprobe elsewhere in this
codebase) rather than a new operation on the persistent process_image.py
worker — this is optional/suggestion-only, not on any hot path, and keeping
it isolated means a bug here can't affect the always-on image-conversion
worker.
"""
import argparse
import json
import sys

import cv2
import numpy as np
from PIL import Image, ImageOps

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from process_image import open_image  # noqa: E402

# Longest edge to analyze at. Horizon/structural lines don't need full
# resolution to detect; this keeps Canny+Hough well under a second even on a
# large source.
ANALYSIS_LONG_EDGE = 900

# Only trust a line as a horizon/structural candidate if its deviation from
# level (0°) or plumb (90°) is within this many degrees. Wider than this is
# far more likely to be an intentionally diagonal composition than a tilted
# camera.
MAX_CANDIDATE_DEVIATION_DEG = 20.0

# Below this, the photo is already level enough that "correcting" it would
# just be sub-pixel jitter, not a real improvement.
MIN_CORRECTION_DEG = 0.5

# A line (or vote bucket) must span at least this fraction of the image's
# diagonal to count as "dominant" rather than an incidental short edge.
MIN_SUPPORT_FRACTION = 0.30

# The winning angle bucket's total support must beat the runner-up bucket by
# at least this ratio — otherwise two comparably-strong but different lines
# (e.g. a level horizon AND an unrelated diagonal railing) make the pick
# genuinely ambiguous, and an ambiguous guess is exactly what must not be
# forced on the user.
MIN_DOMINANCE_RATIO = 1.5

# Degrees per histogram bucket when voting for the dominant angle.
BUCKET_WIDTH_DEG = 1.0


def _fold_to_deviation(angle_deg: float) -> float:
    """Folds a line's raw angle into "degrees off level-or-plumb", signed.

    A line at 1.2° is nearly level (deviation +1.2). A line at 91.5° is
    nearly plumb, and correcting the *photo* the same way a level horizon
    would be corrected means treating it as -88.5 folded to +1.5 the other
    direction from vertical — either way, rotating the frame by that many
    degrees makes the line level or plumb, so both cases feed one vote.
    """
    a = angle_deg % 180.0
    # distance to nearest multiple of 90
    nearest_90 = round(a / 90.0) * 90.0
    return a - nearest_90


def detect_horizon(input_path: str) -> dict:
    img = open_image(input_path)
    img = ImageOps.exif_transpose(img)  # analyze in the orientation the user sees
    img = img.convert("L")

    long_edge = max(img.size)
    if long_edge > ANALYSIS_LONG_EDGE:
        scale = ANALYSIS_LONG_EDGE / long_edge
        img = img.resize(
            (max(1, round(img.width * scale)), max(1, round(img.height * scale))),
            Image.BILINEAR,
        )

    gray = np.array(img)
    h, w = gray.shape
    diagonal = float(np.hypot(h, w))

    edges = cv2.Canny(gray, 50, 150, apertureSize=3)
    min_line_length = max(20, int(diagonal * 0.15))
    lines = cv2.HoughLinesP(
        edges,
        rho=1,
        theta=np.pi / 360,  # 0.5° angular resolution
        threshold=40,
        minLineLength=min_line_length,
        maxLineGap=min_line_length // 4,
    )

    if lines is None or len(lines) == 0:
        return {"angle": None, "reason": "no_lines"}

    # OpenCV has returned this as (N, 1, 4) historically and (N, 4) in some
    # builds (measured: 5.0.0 gives (N, 4)) — reshape defensively so both work.
    lines = lines.reshape(-1, 4)

    # Vote: bucket each candidate line's folded deviation, weighted by length.
    buckets: dict[int, float] = {}
    for (x1, y1, x2, y2) in lines:
        length = float(np.hypot(x2 - x1, y2 - y1))
        raw_angle = np.degrees(np.arctan2(y2 - y1, x2 - x1))
        deviation = _fold_to_deviation(raw_angle)
        if abs(deviation) > MAX_CANDIDATE_DEVIATION_DEG:
            continue
        bucket = round(deviation / BUCKET_WIDTH_DEG)
        buckets[bucket] = buckets.get(bucket, 0.0) + length

    if not buckets:
        return {"angle": None, "reason": "no_near_level_or_plumb_lines"}

    ranked = sorted(buckets.items(), key=lambda kv: kv[1], reverse=True)
    winner_bucket, winner_support = ranked[0]
    runner_up_support = ranked[1][1] if len(ranked) > 1 else 0.0

    support_fraction = winner_support / diagonal
    dominance_ratio = winner_support / runner_up_support if runner_up_support > 0 else float("inf")
    correction_deg = -(winner_bucket * BUCKET_WIDTH_DEG)  # rotate opposite the tilt

    if support_fraction < MIN_SUPPORT_FRACTION:
        return {"angle": None, "reason": "insufficient_support", "supportFraction": support_fraction}
    if dominance_ratio < MIN_DOMINANCE_RATIO:
        return {"angle": None, "reason": "ambiguous", "dominanceRatio": dominance_ratio}
    if abs(correction_deg) < MIN_CORRECTION_DEG:
        return {"angle": None, "reason": "already_level"}

    confidence = min(1.0, support_fraction) * min(1.0, dominance_ratio / (MIN_DOMINANCE_RATIO * 2))
    return {
        "angle": round(correction_deg, 2),
        "confidence": round(confidence, 3),
        "supportFraction": round(support_fraction, 3),
        "dominanceRatio": round(min(dominance_ratio, 99.0), 2),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input_path")
    args = parser.parse_args()
    try:
        result = detect_horizon(args.input_path)
    except Exception as exc:  # noqa: BLE001 — this is a best-effort suggestion, never fatal
        result = {"angle": None, "reason": "error", "message": str(exc)}
    print(json.dumps(result))


if __name__ == "__main__":
    main()
