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


def main():
    device = sys.argv[1] if len(sys.argv) > 1 else "cpu"

    try:
        model = load_model(device)
    except Exception as e:
        if device == "cuda":
            try:
                model = load_model("cpu")
            except Exception as e2:
                send({"type": "error", "error": str(e2)})
                sys.exit(1)
        else:
            send({"type": "error", "error": str(e)})
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
            if operation == "transcribe":
                segments = transcribe(model, request["videoPath"])
                send({"id": req_id, "segments": segments})
            else:
                send({"id": req_id, "error": f"Unknown operation: {operation}"})
        except Exception as e:
            send({"id": req_id, "error": str(e)})


if __name__ == "__main__":
    main()
