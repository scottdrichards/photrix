"""Which compute device each model runs on, for any vendor.

The workers used to know two devices: "cuda" and "cpu". This module is the one
place that knows the rest, so a worker asks it instead of calling
`torch.cuda.*` directly:

- **PyTorch** (CLIP, CLAP): `cuda` (NVIDIA, and AMD under a ROCm build of
  torch, which reports itself as CUDA), `xpu` (Intel Arc / Core Ultra), `mps`
  (Apple Silicon), else `cpu`.
- **ONNX Runtime** (the face models): whichever GPU execution provider the
  installed onnxruntime package ships. Exactly one of `onnxruntime`,
  `onnxruntime-gpu`, `onnxruntime-directml`, ... can be installed at a time; the
  standard macOS `onnxruntime` wheel already includes CoreML.

A device counts only once a real tensor operation has run on it.
`torch.cuda.is_available()` alone says True on a card whose kernels the
installed torch build doesn't ship, and then every op fails with "no kernel
image is available for execution on the device". Running out of memory during
the check is different: the device works and is just full right now, so it
still counts (callers have their own out-of-memory fallbacks).
"""
from __future__ import annotations

import re
from typing import Any, Iterable

CPU = "cpu"
CPU_PROVIDER = "CPUExecutionProvider"
CUDA_PROVIDER = "CUDAExecutionProvider"

# Tried in this order; the first that runs a real op wins.
TORCH_GPU_DEVICES = ("cuda", "xpu", "mps")

# GPU execution providers in preference order. TensorRT is left out on purpose:
# it builds an engine per input shape on first use, which is minutes of stall
# for a worker that sees one image at a time.
ORT_GPU_PROVIDERS = (
    CUDA_PROVIDER,
    "ROCMExecutionProvider",
    "MIGraphXExecutionProvider",
    "DmlExecutionProvider",
    "CoreMLExecutionProvider",
    "OpenVINOExecutionProvider",
)

_OUT_OF_MEMORY = re.compile(r"out of memory|failed to allocate", re.IGNORECASE)


def is_gpu_device(device: str | None) -> bool:
    return bool(device) and device.strip().lower() != CPU


def is_gpu_provider(provider: str | None) -> bool:
    return bool(provider) and provider.strip() != CPU_PROVIDER


def torch_backend_available(torch: Any, device: str) -> bool:
    """What torch itself claims, before anything is verified."""
    try:
        if device == "cuda":
            return bool(torch.cuda.is_available())
        if device == "mps":
            mps = getattr(getattr(torch, "backends", None), "mps", None)
            return bool(mps is not None and mps.is_available())
        module = getattr(torch, device, None)
        return bool(module is not None and module.is_available())
    except Exception:  # noqa: BLE001 - a broken backend is simply unavailable
        return False


def verify_torch_device(torch: Any, device: str) -> str | None:
    """Run a real op on `device`. None means it works; otherwise the reason."""
    try:
        x = torch.randn(4, 4, device=device)
        float((x @ x).sum().item())
        return None
    except Exception as exc:  # noqa: BLE001 - every failure is a reason
        if _OUT_OF_MEMORY.search(str(exc)):
            return None
        return f"{type(exc).__name__}: {exc}".strip()


def torch_backend_name(torch: Any, device: str) -> str:
    """`rocm` for an AMD card behind torch's CUDA API, else the device itself."""
    if device == "cuda" and getattr(getattr(torch, "version", None), "hip", None):
        return "rocm"
    return device


def pick_torch_device(
    torch: Any, candidates: Iterable[str] = TORCH_GPU_DEVICES
) -> tuple[str, dict[str, str]]:
    """The first candidate that runs a real op, and why the others didn't."""
    rejected: dict[str, str] = {}
    for device in candidates:
        if not torch_backend_available(torch, device):
            rejected[device] = "not available"
            continue
        reason = verify_torch_device(torch, device)
        if reason is None:
            return device, rejected
        rejected[device] = reason
    return CPU, rejected


def pick_ort_provider(available: Iterable[str]) -> str:
    available = set(available)
    for provider in ORT_GPU_PROVIDERS:
        if provider in available:
            return provider
    return CPU_PROVIDER


def empty_cache(torch: Any, device: str | None) -> None:
    """Hand cached-but-unused GPU blocks back to the driver. No-op on CPU."""
    if not is_gpu_device(device):
        return
    module = getattr(torch, device.strip().lower(), None)
    fn = getattr(module, "empty_cache", None)
    if fn is None:
        return
    try:
        fn()
    except Exception:  # noqa: BLE001 - best effort
        pass
