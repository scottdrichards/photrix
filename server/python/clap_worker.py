#!/usr/bin/env python3
"""
CLAP audio embedding worker.
Maps audio and text to a shared 512-dim embedding space for semantic audio search.
Communicates via stdin/stdout JSON lines, same protocol as image_analysis_worker.py.

Install: pip install transformers soundfile torch
GPU:     pip install torch --index-url https://download.pytorch.org/whl/cu121
Model:   laion/larger_clap_music_and_speech (auto-downloaded on first run)

Request (embed audio from a video/audio file):
  {"id": 1, "operation": "embedAudio", "videoPath": "/path/to/video.mp4"}

Request (embed text query for search):
  {"id": 2, "operation": "embedText", "text": "fighter jet sounds"}

Response:
  {"id": 1, "embedding": [0.1, 0.2, ...]}  # 512 float32 values, L2-normalised
  {"id": 1, "error": "error message"}
"""
import json
import os
import subprocess
import sys

import numpy as np


def send(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


TARGET_SR = 48_000
CHUNK_SECONDS = 10
MODEL_ID = "laion/larger_clap_music_and_speech"


def _features(output):
    """Extract the projected embedding tensor.

    transformers >=5 returns a BaseModelOutputWithPooling whose `pooler_output`
    holds the projected, L2-normalised embedding; older versions return the
    tensor directly.
    """
    return getattr(output, "pooler_output", output)


def _embed_chunk(model, processor, chunk: np.ndarray, device: str) -> np.ndarray:
    import torch

    inputs = processor(audio=chunk, sampling_rate=TARGET_SR, return_tensors="pt")
    inputs = {k: v.to(device) for k, v in inputs.items()}
    with torch.no_grad():
        feat = _features(model.get_audio_features(**inputs))
        feat = feat / feat.norm(dim=-1, keepdim=True)
    return feat.cpu().float().numpy()[0]


def embed_audio_streaming(model, processor, video_path: str, device: str) -> list:
    """Stream raw float32 PCM from ffmpeg in fixed chunks; never loads the full audio into memory."""
    chunk_samples = TARGET_SR * CHUNK_SECONDS
    chunk_bytes = chunk_samples * 4  # float32 = 4 bytes per sample

    proc = subprocess.Popen(
        [
            "ffmpeg", "-y",
            "-i", video_path,
            "-ar", str(TARGET_SR),
            "-ac", "1",
            "-f", "f32le",  # raw 32-bit float PCM, little-endian
            "pipe:1",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )

    embeddings = []
    buf = bytearray()

    try:
        while True:
            piece = proc.stdout.read(65536)
            if not piece:
                break
            buf.extend(piece)
            while len(buf) >= chunk_bytes:
                chunk = np.frombuffer(bytes(buf[:chunk_bytes]), dtype=np.float32).copy()
                del buf[:chunk_bytes]
                embeddings.append(_embed_chunk(model, processor, chunk, device))
        # Process any remaining samples (partial final chunk)
        if buf:
            chunk = np.frombuffer(bytes(buf), dtype=np.float32).copy()
            chunk = np.pad(chunk, (0, chunk_samples - len(chunk)))
            embeddings.append(_embed_chunk(model, processor, chunk, device))
    finally:
        proc.stdout.close()
        proc.wait()

    if not embeddings:
        raise ValueError("No audio could be extracted from the file")

    avg = np.mean(embeddings, axis=0)
    norm = np.linalg.norm(avg)
    return (avg / norm if norm > 0 else avg).tolist()


def embed_text(model, processor, text: str, device: str) -> list:
    import torch

    inputs = processor(text=[text], return_tensors="pt", padding=True)
    inputs = {k: v.to(device) for k, v in inputs.items()}
    with torch.no_grad():
        features = _features(model.get_text_features(**inputs))
        features = features / features.norm(dim=-1, keepdim=True)
    return features.cpu().float().numpy()[0].tolist()


def main():
    try:
        import torch
        from transformers import ClapModel, ClapProcessor

        device = "cuda" if torch.cuda.is_available() else "cpu"

        hf_home = os.environ.get("HF_HOME", os.path.expanduser("~/.cache/huggingface"))
        model = ClapModel.from_pretrained(MODEL_ID, cache_dir=hf_home)
        processor = ClapProcessor.from_pretrained(MODEL_ID, cache_dir=hf_home)
        model = model.to(device)
        model.eval()
    except Exception as e:
        send({"type": "error", "error": f"Failed to load CLAP model: {e}"})
        sys.exit(1)

    send({"type": "ready", "device": device})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            continue

        req_id = request.get("id")
        operation = request.get("operation")

        try:
            if operation == "embedAudio":
                video_path = request["videoPath"]
                embedding = embed_audio_streaming(model, processor, video_path, device)
                send({"id": req_id, "embedding": embedding})

            elif operation == "embedText":
                embedding = embed_text(model, processor, request["text"], device)
                send({"id": req_id, "embedding": embedding})

            else:
                send({"id": req_id, "error": f"Unknown operation: {operation}"})

        except Exception as e:
            send({"id": req_id, "error": str(e)})


if __name__ == "__main__":
    main()
