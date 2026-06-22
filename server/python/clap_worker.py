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
import tempfile

import numpy as np


def send(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


TARGET_SR = 48_000
CHUNK_SECONDS = 10
MODEL_ID = "laion/larger_clap_music_and_speech"


def extract_audio(video_path: str, wav_path: str) -> None:
    """Extract mono 48 kHz PCM audio from any video/audio file via ffmpeg."""
    subprocess.run(
        [
            "ffmpeg", "-y",
            "-i", video_path,
            "-ar", str(TARGET_SR),
            "-ac", "1",
            "-f", "wav",
            wav_path,
        ],
        check=True,
        capture_output=True,
    )


def load_audio(wav_path: str) -> np.ndarray:
    import soundfile as sf

    audio, sr = sf.read(wav_path, dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if sr != TARGET_SR:
        # Resample if soundfile gave a different rate (shouldn't happen after ffmpeg)
        import librosa
        audio = librosa.resample(audio, orig_sr=sr, target_sr=TARGET_SR)
    return audio


def _features(output):
    """Extract the projected embedding tensor.

    transformers >=5 returns a BaseModelOutputWithPooling whose `pooler_output`
    holds the projected, L2-normalised embedding; older versions return the
    tensor directly.
    """
    return getattr(output, "pooler_output", output)


def embed_audio(model, processor, audio: np.ndarray, device: str) -> list:
    import torch

    chunk_size = TARGET_SR * CHUNK_SECONDS
    # Split into fixed-length chunks; pad the last one
    chunks = [audio[i : i + chunk_size] for i in range(0, max(len(audio), 1), chunk_size)]
    if chunks and len(chunks[-1]) < chunk_size:
        chunks[-1] = np.pad(chunks[-1], (0, chunk_size - len(chunks[-1])))

    embeddings = []
    for chunk in chunks:
        inputs = processor(audio=chunk, sampling_rate=TARGET_SR, return_tensors="pt")
        inputs = {k: v.to(device) for k, v in inputs.items()}
        with torch.no_grad():
            features = _features(model.get_audio_features(**inputs))
            features = features / features.norm(dim=-1, keepdim=True)
            embeddings.append(features.cpu().float().numpy()[0])

    avg = np.mean(embeddings, axis=0)
    norm = np.linalg.norm(avg)
    if norm > 0:
        avg = avg / norm
    return avg.tolist()


def embed_text(model, processor, text: str, device: str) -> list:
    import torch

    inputs = processor(text=[text], return_tensors="pt", padding=True)
    inputs = {k: v.to(device) for k, v in inputs.items()}
    with torch.no_grad():
        features = _features(model.get_text_features(**inputs))
        features = features / features.norm(dim=-1, keepdim=True)
    return features.cpu().float().numpy()[0].tolist()


def main():
    device_arg = sys.argv[1] if len(sys.argv) > 1 else "cpu"
    device = "cuda" if "cuda" in device_arg.lower() else "cpu"

    try:
        import torch
        from transformers import ClapModel, ClapProcessor

        if device == "cuda" and not torch.cuda.is_available():
            device = "cpu"

        hf_home = os.environ.get("HF_HOME", os.path.expanduser("~/.cache/huggingface"))
        model = ClapModel.from_pretrained(MODEL_ID, cache_dir=hf_home)
        processor = ClapProcessor.from_pretrained(MODEL_ID, cache_dir=hf_home)
        model = model.to(device)
        model.eval()
    except Exception as e:
        send({"type": "error", "error": f"Failed to load CLAP model: {e}"})
        sys.exit(1)

    send({"type": "ready"})

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
                with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                    tmp_path = tmp.name
                try:
                    extract_audio(video_path, tmp_path)
                    audio = load_audio(tmp_path)
                    embedding = embed_audio(model, processor, audio, device)
                    send({"id": req_id, "embedding": embedding})
                finally:
                    os.unlink(tmp_path)

            elif operation == "embedText":
                embedding = embed_text(model, processor, request["text"], device)
                send({"id": req_id, "embedding": embedding})

            else:
                send({"id": req_id, "error": f"Unknown operation: {operation}"})

        except Exception as e:
            send({"id": req_id, "error": str(e)})


if __name__ == "__main__":
    main()
