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
import os
import sys

from worker_memory import trim_heap


def send(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def load_model(device: str, compute_type: str):
    from faster_whisper import WhisperModel

    # On CPU, cap threads so transcription doesn't starve foreground work.
    # SIGSTOP already freezes the worker during user requests; this keeps
    # background CPU usage bounded while the worker is running.
    kwargs = {}
    if device == "cpu":
        kwargs["cpu_threads"] = int(os.environ.get("WHISPER_CPU_THREADS", "2"))
    # "medium" instead of "large-v3": ~1/3 the VRAM and noticeably faster,
    # with a modest accuracy trade-off. large-v3 kept crowding out other GPU
    # workers on a shared card.
    return WhisperModel("medium", device=device, compute_type=compute_type, **kwargs)


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


def _is_unsupported_compute_type_error(exc: Exception) -> bool:
    # Raised by CTranslate2 when the requested compute type needs hardware the
    # device doesn't have — e.g. int8_float16's fp16 accumulation needs Tensor
    # Cores (Turing+, compute capability >= 7.0), so it fails this way on an
    # older CUDA generation (Pascal, e.g. this box's Quadro P520 at 6.1) even
    # though CUDA itself and plain int8 both work fine there. Not a "no GPU"
    # failure, so it should retry the SAME device with a cheaper compute type
    # rather than falling all the way back to CPU.
    return "do not support" in str(exc) and "compute" in str(exc)


def main():
    device = detect_device()
    # int8_float16 keeps compute in fp16 but stores weights as int8, roughly
    # halving resident VRAM with negligible accuracy loss over plain int8 —
    # preferred when the GPU has the Tensor Cores to run it efficiently.
    # CPU never gets a choice; int8 is the only compute type it supports.
    compute_type = "int8_float16" if device == "cuda" else "int8"
    fallback_from = None
    fallback_reason = None

    try:
        model = load_model(device, compute_type)
    except Exception as e:
        if device == "cuda" and _is_unsupported_compute_type_error(e):
            # Stay on the GPU, just ask it for less: plain int8 (via DP4A) is
            # supported back to compute capability 6.1, one generation before
            # Tensor Cores existed at all.
            try:
                fallback_from = compute_type
                fallback_reason = str(e)
                compute_type = "int8"
                model = load_model(device, compute_type)
            except Exception as e2:
                fallback_from = device
                fallback_reason = str(e2)
                device = "cpu"
                compute_type = "int8"
                model = load_model(device, compute_type)
        elif device == "cuda":
            try:
                fallback_from = device
                fallback_reason = str(e)
                device = "cpu"
                compute_type = "int8"
                model = load_model(device, compute_type)
            except Exception as e2:
                send({
                    "type": "error",
                    "error": (
                        "Whisper CUDA initialization failed: "
                        f"{e}; CPU fallback also failed: {e2}"
                    ),
                })
                sys.exit(1)
        else:
            send({"type": "error", "error": str(e)})
            sys.exit(1)

    # The weights are on the card now; hand the load buffers back to the OS.
    trim_heap()

    ready = {"type": "ready", "device": device, "computeType": compute_type}
    if fallback_from is not None:
        ready["fallbackFrom"] = fallback_from
        ready["fallbackReason"] = fallback_reason
    send(ready)

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
