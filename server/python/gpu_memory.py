#!/usr/bin/env python3
"""Free-GPU-memory checks that don't create a CUDA context.

Asking torch how much memory is free (`torch.cuda.mem_get_info`) creates a CUDA
context first, and on a small card that context alone costs a few hundred MiB,
which is the very memory the question was about. `nvidia-smi` reads the
driver's numbers from outside the process, so a worker can decide CPU-or-GPU
before it touches CUDA at all.
"""
from __future__ import annotations

import contextlib
import os
import subprocess
from typing import Callable, Mapping


CPU_PROVIDER = "CPUExecutionProvider"

# Steady-state GPU footprint of each model, with some headroom for activations.
# Measured on a Pascal card: CLIP ViT-B/32 ~684 MiB, the InsightFace set ~714 MiB
# (~660 sharing CLIP's process), CLAP ~846 MiB.
CLIP_GPU_MIB = 768
FACE_GPU_MIB = 768
CLAP_GPU_MIB = 1024


def gpu_memory_mib(
    run: Callable[..., subprocess.CompletedProcess] = subprocess.run,
) -> tuple[int | None, int | None]:
    """(free, total) memory on GPU 0 in MiB; None for whatever can't be read
    (no nvidia-smi, no NVIDIA GPU, unexpected output)."""
    try:
        out = run(
            [
                "nvidia-smi",
                "--query-gpu=memory.free,memory.total",
                "--format=csv,noheader,nounits",
                "--id=0",
            ],
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
        ).stdout
        free, total = (int(v) for v in out.strip().splitlines()[0].split(","))
        return free, total
    except Exception:  # noqa: BLE001 - unknown means "don't block on it"
        return None, None


def free_gpu_mib(run: Callable[..., subprocess.CompletedProcess] = subprocess.run) -> int | None:
    return gpu_memory_mib(run)[0]


def min_free_mib(env_var: str, default: int) -> int:
    try:
        return int(os.environ.get(env_var) or default)
    except ValueError:
        return default


def has_room(free_mib: int | None, need_mib: int) -> bool:
    """Unknown free memory counts as room: the caller still has its OOM fallback,
    and refusing the GPU on a box where nvidia-smi is just missing would be a
    silent slowdown."""
    return free_mib is None or free_mib >= need_mib


def _face_models_on_gpu(env: Mapping[str, str]) -> bool:
    # Same precedence the Node side uses to pick the face provider.
    provider = (
        env.get("PHOTRIX_INSIGHTFACE_PROVIDER") or env.get("PHOTRIX_CLIP_PROVIDER") or ""
    ).strip()
    return provider not in ("", CPU_PROVIDER)


def clap_gpu_plan(
    env: Mapping[str, str], free_mib: int | None, total_mib: int | None
) -> tuple[bool, str]:
    """Whether CLAP should take the GPU, and why not when it shouldn't.

    CLIP and the face models outrank CLAP. A free-memory check alone races: if
    CLAP starts before they have loaded, it sees an empty card, takes it, and
    they are the ones left without room. So CLAP also stays off the GPU when the
    card is too small to hold every model configured for it at once.
    """
    need_free = CLAP_GPU_MIB
    with contextlib.suppress(ValueError):
        need_free = int(env.get("PHOTRIX_CLAP_MIN_FREE_GPU_MIB") or CLAP_GPU_MIB)
    if not has_room(free_mib, need_free):
        return False, f"{free_mib} MiB GPU free, under {need_free}"

    resident = CLAP_GPU_MIB
    if (env.get("PHOTRIX_CLIP_DEVICE") or "").strip().lower() == "cuda":
        resident += CLIP_GPU_MIB
    if _face_models_on_gpu(env):
        resident += FACE_GPU_MIB
    if total_mib is not None and total_mib < resident:
        return False, (
            f"the card has {total_mib} MiB; CLIP, the face models and CLAP together "
            f"need ~{resident}, and CLIP and the face models go first"
        )
    return True, ""
