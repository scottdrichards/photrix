#!/usr/bin/env python3
"""Report which compute devices this machine's Python environment can use.

The server runs this once at startup and hands the answer to every ML worker,
so they don't each have to work out the hardware. It's also the
`python:report` command, for checking a machine by hand.

Prints one JSON object on stdout and always exits 0. A missing or broken
package shows up as `cpu` with the reason, not as a crash.

  {
    "platform": "linux", "machine": "x86_64", "python": "3.14.0",
    "torch": {"device": "cuda", "backend": "cuda", "version": "2.9.1+cu126",
              "rejected": {}, "error": null},
    "ort": {"provider": "CUDAExecutionProvider",
            "available": ["CUDAExecutionProvider", "CPUExecutionProvider"],
            "version": "1.26.0", "error": null}
  }

The torch check runs a real op on the device, so it briefly creates a GPU
context. It's a separate short-lived process, so that memory is gone when it
exits.
"""
from __future__ import annotations

import contextlib
import json
import platform
import sys

from accel import CPU, CPU_PROVIDER, pick_ort_provider, pick_torch_device, torch_backend_name


def probe_torch() -> dict:
    try:
        import torch
    except Exception as exc:  # noqa: BLE001 - reported, not raised
        return {"device": CPU, "backend": CPU, "version": None, "rejected": {},
                "error": f"import torch failed: {exc}"}
    device, rejected = pick_torch_device(torch)
    return {
        "device": device,
        "backend": torch_backend_name(torch, device),
        "version": getattr(torch, "__version__", None),
        "rejected": rejected,
        "error": None,
    }


def probe_ort() -> dict:
    try:
        import onnxruntime as ort
    except Exception as exc:  # noqa: BLE001 - e.g. libcudart.so.13 missing
        return {"provider": CPU_PROVIDER, "available": [], "version": None,
                "error": f"import onnxruntime failed: {exc}"}
    available = list(ort.get_available_providers())
    return {
        "provider": pick_ort_provider(available),
        "available": available,
        "version": getattr(ort, "__version__", None),
        "error": None,
    }


def main() -> None:
    # Some packages print banners while importing; keep stdout to the JSON line.
    with contextlib.redirect_stdout(sys.stderr):
        report = {
            "platform": sys.platform,
            "machine": platform.machine(),
            "python": platform.python_version(),
            "torch": probe_torch(),
            "ort": probe_ort(),
        }
    sys.stdout.write(json.dumps(report) + "\n")


if __name__ == "__main__":
    main()
