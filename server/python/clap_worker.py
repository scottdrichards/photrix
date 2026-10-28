#!/usr/bin/env python3
"""
CLAP audio embedding worker.
Maps audio and text to a shared 512-dim embedding space for semantic audio search.
Communicates via stdin/stdout JSON lines, same protocol as image_analysis_worker.py.

Install: `bun run --filter server python:install` (picks the GPU build of torch)
Device:  PHOTRIX_CLAP_DEVICE, else PHOTRIX_TORCH_DEVICE (set by the server from
         accel_probe.py), else whatever accel.pick_torch_device finds.
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

from accel import CPU, empty_cache, is_gpu_device, pick_torch_device
from gpu_memory import clap_gpu_plan, gpu_memory_mib
from worker_memory import trim_heap


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


def _requested_device() -> str | None:
    for name in ("PHOTRIX_CLAP_DEVICE", "PHOTRIX_TORCH_DEVICE"):
        value = (os.environ.get(name) or "").strip().lower()
        if value:
            return value
    return None


def _place_model(model, torch, device: str):
    """Move the model to `device` if it fits, else keep it on CPU."""
    if not is_gpu_device(device):
        return model, CPU
    try:
        return model.to(device), device
    except RuntimeError as exc:  # torch.OutOfMemoryError subclasses RuntimeError
        if "out of memory" not in str(exc).lower():
            raise
        print(f"CLAP: GPU out of memory, running on CPU: {exc}", file=sys.stderr)
        model = model.to(CPU)
        empty_cache(torch, device)
        return model, CPU


def main():
    try:
        # CLAP (~850 MiB on the GPU) shares the card with CLIP and the face
        # models, which outrank it: search needs CLIP, and the face models are
        # far faster on the GPU. Decided with nvidia-smi before torch is
        # imported, because a CPU fallback that had already created a CUDA
        # context would still hold a few hundred MiB of the card.
        #
        # That memory plan reads nvidia-smi, so it only applies to CUDA. Other
        # GPUs go straight to the device, with the out-of-memory fallback in
        # _place_model.
        device = _requested_device()
        if device in (None, "cuda"):
            use_gpu, reason = clap_gpu_plan(os.environ, *gpu_memory_mib())
            if not use_gpu:
                print(f"CLAP: running on CPU: {reason}", file=sys.stderr)
                os.environ["CUDA_VISIBLE_DEVICES"] = ""
                device = CPU

        import torch
        if device is None:
            device, _rejected = pick_torch_device(torch)
        from transformers import ClapModel, ClapProcessor

        hf_home = os.environ.get("HF_HOME", os.path.expanduser("~/.cache/huggingface"))
        model = ClapModel.from_pretrained(MODEL_ID, cache_dir=hf_home)
        processor = ClapProcessor.from_pretrained(MODEL_ID, cache_dir=hf_home)
        model, device = _place_model(model, torch, device)
        model.eval()
    except Exception as e:
        send({"type": "error", "error": f"Failed to load CLAP model: {e}"})
        sys.exit(1)

    # Release the one-off weight-loading buffers glibc is still holding.
    trim_heap()

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
        finally:
            # Hand transient GPU blocks back to the driver between requests so an
            # on-demand video transcode can claim the headroom. Model weights stay
            # resident. CLAP requests are infrequent, so the cost is negligible.
            empty_cache(torch, device)


if __name__ == "__main__":
    main()
