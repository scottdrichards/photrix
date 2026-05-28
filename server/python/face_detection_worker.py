#!/usr/bin/env python3
import contextlib
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps
from pillow_heif import register_heif_opener

from insightface.app import FaceAnalysis

register_heif_opener()


def load_image_bgr(image_path: str) -> np.ndarray:
    path = Path(image_path)
    if not path.exists():
        raise FileNotFoundError(f"Image not found: {image_path}")

    with Image.open(path) as image:
        # Keep orientation consistent with user-visible rendering.
        oriented = ImageOps.exif_transpose(image).convert("RGB")
        rgb = np.asarray(oriented)

    # InsightFace expects BGR channel order.
    return rgb[:, :, ::-1].copy()


def normalize_box(bbox: np.ndarray, width: int, height: int) -> dict:
    x1, y1, x2, y2 = [float(v) for v in bbox]
    return {
        "x": x1 / width,
        "y": y1 / height,
        "width": max(0.0, (x2 - x1) / width),
        "height": max(0.0, (y2 - y1) / height),
    }


def create_app() -> FaceAnalysis:
    provider = (sys.argv[1] if len(sys.argv) > 1 else "CPUExecutionProvider").strip()
    ctx_id = -1 if provider == "CPUExecutionProvider" else 0

    with contextlib.redirect_stdout(sys.stderr):
        app = FaceAnalysis(name="buffalo_l", providers=[provider])
        app.prepare(ctx_id=ctx_id)
    return app


def detect_faces(app: FaceAnalysis, image_path: str) -> list[dict]:
    bgr = load_image_bgr(image_path)
    height, width = bgr.shape[:2]

    with contextlib.redirect_stdout(sys.stderr):
        faces = app.get(bgr)

    result: list[dict] = []
    for face in faces:
        embedding = face.normed_embedding
        if embedding is None:
            continue

        result.append(
            {
                "box": normalize_box(face.bbox, width, height),
                "confidence": float(face.det_score),
                "embedding": [float(v) for v in embedding.tolist()],
            }
        )

    return result


def send(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main() -> int:
    app = create_app()
    send({"type": "ready"})

    for line in sys.stdin:
        raw = line.strip()
        if not raw:
            continue

        req_id = None
        try:
            payload = json.loads(raw)
            req_id = payload.get("id")
            image_path = payload.get("imagePath")
            if not isinstance(req_id, int):
                raise ValueError("Request id must be an integer")
            if not isinstance(image_path, str) or not image_path:
                raise ValueError("imagePath must be a non-empty string")

            faces = detect_faces(app, image_path)
            send({"id": req_id, "faces": faces})
        except Exception as error:  # noqa: BLE001 - worker should return controlled errors
            send({
                "id": req_id,
                "error": str(error),
            })

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
