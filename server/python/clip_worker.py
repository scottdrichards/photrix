#!/usr/bin/env python3
"""
CLIP image and text embedding worker.
Communicates via stdin/stdout JSON lines, same protocol as face_detection_worker.py.

Install: pip install open_clip_torch
GPU:     pip install torch --index-url https://download.pytorch.org/whl/cu121

Request format:
  {"id": 1, "operation": "embedImage", "imagePath": "/path/to/image.jpg"}
  {"id": 2, "operation": "embedText",  "text": "eating a burrito at night"}

Response format:
  {"id": 1, "embedding": [0.1, 0.2, ...]}  # 512 float32 values, L2-normalised
  {"id": 1, "error": "error message"}
"""
import json
import os
import queue as _queue
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image, ImageOps
from pillow_heif import register_heif_opener

# Local files can be legitimately large (panoramas, high-res cameras).
# CLIP resizes to 224x224 regardless, so the bomb limit adds no safety value here.
Image.MAX_IMAGE_PIXELS = None

register_heif_opener()

# Suppress onnxruntime warnings when torch loads onnx models
import onnxruntime as ort
ort.set_default_logger_severity(4)

MAX_BATCH_SIZE = 16
IO_WORKERS = 2       # conservative for shared spinning disk
BATCH_TIMEOUT = 0.05 # 50ms to accumulate a full batch


def send(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def create_model(device: str):
    import open_clip
    import torch

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
    return model, preprocess, tokenizer, torch


def _start_stdin_reader() -> _queue.Queue:
    q: _queue.Queue = _queue.Queue()

    def _read() -> None:
        for line in sys.stdin:
            stripped = line.strip()
            if stripped:
                q.put(stripped)
        q.put(None)  # EOF sentinel

    threading.Thread(target=_read, daemon=True).start()
    return q


def _collect_batch(q: _queue.Queue) -> list[str] | None:
    """Block up to BATCH_TIMEOUT for the first item, then drain greedily."""
    lines: list[str] = []
    try:
        item = q.get(timeout=BATCH_TIMEOUT)
    except _queue.Empty:
        return lines
    if item is None:
        return None
    lines.append(item)
    while len(lines) < MAX_BATCH_SIZE:
        try:
            item = q.get_nowait()
        except _queue.Empty:
            break
        if item is None:
            q.put(None)  # restore sentinel for next call
            break
        lines.append(item)
    return lines


def _load_tensor(image_path: str, preprocess):
    path = Path(image_path)
    if not path.exists():
        raise FileNotFoundError(f"Image not found: {image_path}")
    with Image.open(path) as img:
        img = ImageOps.exif_transpose(img).convert("RGB")
    return preprocess(img)


def _process_batch(requests: list[dict], model, preprocess, tokenizer, device: str, torch, executor: ThreadPoolExecutor) -> None:
    image_ops: list[tuple[int, str]] = []
    text_ops: list[tuple[int, str]] = []

    for req in requests:
        req_id = req.get("id")
        if not isinstance(req_id, int):
            send({"id": req_id, "error": "Request id must be an integer"})
            continue
        op = req.get("operation")
        if op == "embedImage":
            image_path = req.get("imagePath")
            if not isinstance(image_path, str) or not image_path:
                send({"id": req_id, "error": "imagePath must be a non-empty string"})
            else:
                image_ops.append((req_id, image_path))
        elif op == "embedText":
            text = req.get("text")
            if not isinstance(text, str) or not text:
                send({"id": req_id, "error": "text must be a non-empty string"})
            else:
                text_ops.append((req_id, text))
        else:
            send({"id": req_id, "error": f"Unknown operation: {op!r}"})

    if image_ops:
        # Load all images in parallel, then run a single batched GPU forward pass
        futures = [(req_id, executor.submit(_load_tensor, img_path, preprocess))
                   for req_id, img_path in image_ops]

        valid_ids: list[int] = []
        tensors = []
        for req_id, fut in futures:
            try:
                tensors.append(fut.result())
                valid_ids.append(req_id)
            except Exception as exc:
                send({"id": req_id, "error": str(exc)})

        if tensors:
            batch = torch.stack(tensors).to(device)
            with torch.no_grad():
                features = model.encode_image(batch)
                features = features / features.norm(dim=-1, keepdim=True)
            for req_id, feat in zip(valid_ids, features.cpu().float()):
                send({"id": req_id, "embedding": feat.tolist()})

    if text_ops:
        ids, texts = zip(*text_ops)
        tokens = tokenizer(list(texts)).to(device)
        with torch.no_grad():
            features = model.encode_text(tokens)
            features = features / features.norm(dim=-1, keepdim=True)
        for req_id, feat in zip(ids, features.cpu().float()):
            send({"id": req_id, "embedding": feat.tolist()})


def main() -> int:
    provider = (sys.argv[1] if len(sys.argv) > 1 else "CPUExecutionProvider").strip()
    device = "cuda" if provider == "CUDAExecutionProvider" else "cpu"

    print(f"[clip_worker] Loading CLIP ViT-B/32 on {device}...", file=sys.stderr)
    model, preprocess, tokenizer, torch = create_model(device)
    send({"type": "ready"})

    q = _start_stdin_reader()
    with ThreadPoolExecutor(max_workers=IO_WORKERS) as executor:
        while True:
            lines = _collect_batch(q)
            if lines is None:
                break  # stdin closed
            if not lines:
                continue

            requests: list[dict] = []
            for line in lines:
                try:
                    requests.append(json.loads(line))
                except json.JSONDecodeError:
                    pass

            _process_batch(requests, model, preprocess, tokenizer, device, torch, executor)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
