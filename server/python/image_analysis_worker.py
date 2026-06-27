#!/usr/bin/env python3
"""
Combined image-analysis worker: face detection (InsightFace) + CLIP embedding.

The whole point of this worker is to decode each image **once** and then run
whichever models are requested, so the background pipeline no longer loads and
decodes every photo twice (once for faces, once for the semantic embedding).

Communicates via stdin/stdout JSON lines, same protocol as the other workers.

Request formats:
  # Run faces, embedding, or both on a single decode. Omitted flags default off.
  {"id": 1, "operation": "analyzeImage", "imagePath": "/p.jpg", "faces": true, "embed": true}
  # Text embedding for search queries (no image decode).
  {"id": 2, "operation": "embedText", "text": "eating a burrito at night"}

Response formats:
  {"id": 1, "faces": [ {box, confidence, embedding}, ... ], "embedding": [..512..]}
  {"id": 1, "faces": [...], "embeddingError": "..."}   # per-part failure
  {"id": 1, "error": "Image not found: ..."}           # decode/whole-request failure
  {"id": 2, "embedding": [..512..]}

Models are loaded lazily on first use so a library with only faces enabled never
pays to load CLIP (and vice versa). Requests are processed sequentially: running
both heavy models per image is already CPU-bound, and serial processing keeps the
worker from pegging a shared box — the Node side controls how many files are in
flight.
"""
import contextlib
import json
import os
import queue
import shutil
import sys
import threading
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps
from pillow_heif import register_heif_opener

# Local files can be legitimately large (panoramas, high-res cameras); both
# models downscale internally so the decompression-bomb guard adds no safety.
Image.MAX_IMAGE_PIXELS = None

# Suppress pthread_setaffinity_np / onnx warnings logged by ORT's thread pool in
# container/VM environments where CPU affinity doesn't cover all logical cores.
import onnxruntime as ort
ort.set_default_logger_severity(4)

register_heif_opener()

PROVIDER = (sys.argv[1] if len(sys.argv) > 1 else "CPUExecutionProvider").strip()

# Lock held during any CLIP forward pass so the text-embedding thread and the
# image-analysis main thread don't run the model concurrently.
_clip_lock = threading.Lock()
# stdout is written from both threads; serialise to avoid interleaved JSON.
_send_lock = threading.Lock()
# embedText requests are enqueued here and processed by a dedicated thread so
# they are never blocked by a long-running analyzeImage on the main thread.
_text_queue: queue.SimpleQueue[tuple[int, str] | None] = queue.SimpleQueue()
# analyzeImage payloads are enqueued here and processed by the main thread.
_image_queue: queue.SimpleQueue[dict | None] = queue.SimpleQueue()

# Foreground (search) embedText requests must preempt the background image
# backlog. The Node side caps how many analyzeImage requests it dispatches, but
# several can still be sitting in _image_queue, and the main thread would drain
# them one CLIP pass at a time before the text thread ever wins _clip_lock — so a
# search query waits behind the whole queued backlog and times out under load.
# _text_pending counts queued/in-flight embedText requests; the image loop waits
# on this condition before starting each (CPU-heavy) image pass, so a search is
# delayed by at most the single image pass already running, never the backlog.
_text_pending = 0
_text_cond = threading.Condition()


def send(payload: dict) -> None:
    with _send_lock:
        sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
        sys.stdout.flush()


# --------------------------------------------------------------------------- #
# Lazy model loading
# --------------------------------------------------------------------------- #

_face_app = None
_clip = None  # (model, preprocess, tokenizer, torch, device)


def _purge_insightface_cache(model_name: str) -> None:
    model_root = Path.home() / ".insightface" / "models"
    for path in [model_root / f"{model_name}.zip", model_root / model_name]:
        if path.exists():
            print(f"Removing corrupted model cache: {path}", file=sys.stderr)
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink()


def _create_face_app(allow_redownload: bool = True):
    from insightface.app import FaceAnalysis

    ctx_id = -1 if PROVIDER == "CPUExecutionProvider" else 0

    devnull = open(os.devnull, "w")
    old_stderr = sys.stderr
    try:
        sys.stderr = devnull
        with contextlib.redirect_stdout(sys.stderr):
            try:
                app = FaceAnalysis(name="buffalo_l", providers=[PROVIDER])
                app.prepare(ctx_id=ctx_id)
            except Exception as exc:
                if allow_redownload and "INVALID_PROTOBUF" in str(exc):
                    _purge_insightface_cache("buffalo_l")
                    return _create_face_app(allow_redownload=False)
                raise
    finally:
        sys.stderr = old_stderr
        devnull.close()
    return app


def _get_face_app():
    global _face_app
    if _face_app is None:
        _face_app = _create_face_app()
    return _face_app


def _create_clip():
    import open_clip
    import torch

    device = "cuda" if PROVIDER == "CUDAExecutionProvider" else "cpu"

    devnull = open(os.devnull, "w")
    old_stderr = sys.stderr
    try:
        sys.stderr = devnull
        model, _, preprocess = open_clip.create_model_and_transforms(
            "ViT-B-32", pretrained="openai", device=device
        )
        tokenizer = open_clip.get_tokenizer("ViT-B-32")
        model.eval()
    finally:
        sys.stderr = old_stderr
        devnull.close()
    return model, preprocess, tokenizer, torch, device


def _get_clip():
    global _clip
    if _clip is None:
        _clip = _create_clip()
    return _clip


# --------------------------------------------------------------------------- #
# Per-decode model runs
# --------------------------------------------------------------------------- #


def _load_oriented_rgb(image_path: str) -> Image.Image:
    """Decode the image once, applying EXIF orientation. Shared by both models."""
    path = Path(image_path)
    if not path.exists():
        raise FileNotFoundError(f"Image not found: {image_path}")
    with Image.open(path) as image:
        return ImageOps.exif_transpose(image).convert("RGB")


def _normalize_box(bbox, width: int, height: int) -> dict:
    x1, y1, x2, y2 = [float(v) for v in bbox]
    return {
        "x": x1 / width,
        "y": y1 / height,
        "width": max(0.0, (x2 - x1) / width),
        "height": max(0.0, (y2 - y1) / height),
    }


def _detect_faces(rgb: Image.Image) -> list[dict]:
    app = _get_face_app()
    width, height = rgb.size
    # InsightFace expects a BGR numpy array.
    bgr = np.asarray(rgb)[:, :, ::-1].copy()

    with contextlib.redirect_stdout(sys.stderr):
        faces = app.get(bgr)

    result: list[dict] = []
    for face in faces:
        embedding = face.normed_embedding
        if embedding is None:
            continue
        result.append(
            {
                "box": _normalize_box(face.bbox, width, height),
                "confidence": float(face.det_score),
                "embedding": [float(v) for v in embedding.tolist()],
            }
        )
    return result


def _embed_image(rgb: Image.Image) -> list[float]:
    model, preprocess, _tokenizer, torch, device = _get_clip()
    tensor = preprocess(rgb).unsqueeze(0).to(device)
    with _clip_lock, torch.no_grad():
        features = model.encode_image(tensor)
        features = features / features.norm(dim=-1, keepdim=True)
    return features[0].cpu().float().tolist()


def _embed_text(text: str) -> list[float]:
    model, _preprocess, tokenizer, torch, device = _get_clip()
    tokens = tokenizer([text]).to(device)
    with _clip_lock, torch.no_grad():
        features = model.encode_text(tokens)
        features = features / features.norm(dim=-1, keepdim=True)
    return features[0].cpu().float().tolist()


def _run_text_worker() -> None:
    """Drain _text_queue, processing embedText requests as they arrive."""
    global _text_pending
    while True:
        item = _text_queue.get()
        if item is None:
            return
        req_id, text = item
        try:
            send({"id": req_id, "embedding": _embed_text(text)})
        except Exception as exc:  # noqa: BLE001
            send({"id": req_id, "error": str(exc)})
        finally:
            # Release the image loop once the foreground backlog clears.
            with _text_cond:
                _text_pending -= 1
                if _text_pending == 0:
                    _text_cond.notify_all()


# --------------------------------------------------------------------------- #
# Request handling
# --------------------------------------------------------------------------- #


def _handle_analyze_image(payload: dict) -> dict:
    req_id = payload.get("id")
    image_path = payload.get("imagePath")
    want_faces = bool(payload.get("faces"))
    want_embed = bool(payload.get("embed"))

    if not isinstance(image_path, str) or not image_path:
        return {"id": req_id, "error": "imagePath must be a non-empty string"}
    if not want_faces and not want_embed:
        return {"id": req_id, "error": "Nothing requested: set faces and/or embed"}

    # A decode failure fails the whole request; both parts share the one decode.
    # It must NOT propagate: this runs on the main thread, and an uncaught
    # exception here kills the worker process — taking down the search
    # text-embedding thread that shares it. Corrupt/truncated images are common
    # in a large library (e.g. PIL "image file is truncated"), so report the
    # decode failure as a per-request error and keep serving.
    #
    # Decode failures are permanent (a truncated file won't fix itself), so
    # "permanent": True tells the Node side to skip this file on future runs.
    try:
        rgb = _load_oriented_rgb(image_path)
    except Exception as exc:  # noqa: BLE001 - report and keep the worker alive
        return {"id": req_id, "error": str(exc), "permanent": True}

    response: dict = {"id": req_id}
    if want_faces:
        try:
            response["faces"] = _detect_faces(rgb)
        except Exception as exc:  # noqa: BLE001 - report per-part, keep worker alive
            response["facesError"] = str(exc)
    if want_embed:
        try:
            response["embedding"] = _embed_image(rgb)
        except Exception as exc:  # noqa: BLE001
            response["embeddingError"] = str(exc)
    return response


def _run_stdin_reader() -> None:
    """Read stdin and dispatch each request to the appropriate queue immediately.

    Running in a dedicated thread means an in-progress analyzeImage on the main
    thread never delays an incoming embedText request from reaching the text
    thread.
    """
    global _text_pending
    for line in sys.stdin:
        raw = line.strip()
        if not raw:
            continue

        req_id = None
        try:
            payload = json.loads(raw)
            req_id = payload.get("id")
            if not isinstance(req_id, int):
                raise ValueError("Request id must be an integer")

            operation = payload.get("operation", "analyzeImage")
            if operation == "analyzeImage":
                _image_queue.put(payload)
            elif operation == "embedText":
                text = payload.get("text")
                if not isinstance(text, str) or not text:
                    raise ValueError("text must be a non-empty string")
                # Mark a foreground request pending *before* enqueuing so the
                # image loop sees it and stops starting new background passes.
                with _text_cond:
                    _text_pending += 1
                _text_queue.put((req_id, text))
            else:
                raise ValueError(f"Unknown operation: {operation!r}")
        except Exception as error:  # noqa: BLE001 - worker returns controlled errors
            send({"id": req_id, "error": str(error)})

    # stdin closed — signal both worker threads to exit.
    _text_queue.put(None)
    _image_queue.put(None)


def main() -> int:
    stdin_thread = threading.Thread(target=_run_stdin_reader, daemon=True)
    text_thread = threading.Thread(target=_run_text_worker, daemon=True)
    stdin_thread.start()
    text_thread.start()

    send({"type": "ready"})

    # Main thread processes image analysis requests from the queue.
    while True:
        item = _image_queue.get()
        if item is None:
            break
        # Let any pending foreground search embedding go first. The text thread
        # and this loop share _clip_lock and the box's CPU; without yielding here
        # a queued backlog of image passes would each take the lock ahead of a
        # waiting search and push it past the Node-side timeout. Waiting here
        # bounds a search's delay to the single image pass already in flight.
        with _text_cond:
            while _text_pending > 0:
                _text_cond.wait()
        # Last line of defence: no single image may ever crash the worker, because
        # that also kills the shared search text-embedding thread and forces a
        # cold model reload. _handle_analyze_image already converts expected
        # failures to error responses; this guards anything unforeseen.
        try:
            send(_handle_analyze_image(item))
        except Exception as exc:  # noqa: BLE001 - keep the worker alive no matter what
            req_id = item.get("id") if isinstance(item, dict) else None
            send({"id": req_id, "error": str(exc)})

    text_thread.join()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
