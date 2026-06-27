#!/usr/bin/env python3
"""
Whisper audio transcription worker.
Communicates via stdin/stdout JSON lines, same protocol as image_analysis_worker.py.

Install: pip install faster-whisper
GPU:     faster-whisper uses CTranslate2 which supports CUDA natively.
         Install the CUDA-enabled build: pip install faster-whisper[cuda]

Request:
  {"id": 1, "operation": "transcribe", "videoPath": "/path/to/video.mp4"}

Response (success):
  {"id": 1, "segments": [{"start": 0.0, "end": 2.5, "text": "hello world"}]}
Response (error):
  {"id": 1, "error": "error message"}
"""
import json
import sys


def send(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def load_model(device: str):
    from faster_whisper import WhisperModel

    compute_type = "float16" if device == "cuda" else "int8"
    return WhisperModel("large-v3", device=device, compute_type=compute_type)


def transcribe(model, video_path: str) -> list:
    segments, _ = model.transcribe(
        video_path,
        beam_size=5,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
    )
    result = []
    for segment in segments:
        text = segment.text.strip()
        if text:
            result.append({
                "start": round(segment.start, 3),
                "end": round(segment.end, 3),
                "text": text,
            })
    return result


def _cuda_rt_available() -> bool:
    """Check whether ctranslate2 can actually load CUDA runtime libraries."""
    try:
        import ctranslate2
        return ctranslate2.get_cuda_device_count() > 0
    except Exception:
        return False


def detect_device() -> str:
    try:
        import torch
        if torch.cuda.is_available() and _cuda_rt_available():
            return "cuda"
    except Exception:
        pass
    return "cpu"


def _is_cuda_lib_error(exc: Exception) -> bool:
    msg = str(exc)
    return "cannot be loaded" in msg or "libcublas" in msg or "CUDA error" in msg


def main():
    device = detect_device()

    try:
        model = load_model(device)
    except Exception as e:
        if device == "cuda":
            try:
                device = "cpu"
                model = load_model(device)
            except Exception as e2:
                send({"type": "error", "error": str(e2)})
                sys.exit(1)
        else:
            send({"type": "error", "error": str(e)})
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
            if operation == "transcribe":
                try:
                    segments = transcribe(model, request["videoPath"])
                except Exception as e:
                    # ctranslate2 loads CUDA libs lazily; if the runtime is
                    # missing at inference time, fall back to CPU silently.
                    if device == "cuda" and _is_cuda_lib_error(e):
                        device = "cpu"
                        model = load_model("cpu")
                        segments = transcribe(model, request["videoPath"])
                    else:
                        raise
                send({"id": req_id, "segments": segments})
            else:
                send({"id": req_id, "error": f"Unknown operation: {operation}"})
        except Exception as e:
            send({"id": req_id, "error": str(e)})


if __name__ == "__main__":
    main()
