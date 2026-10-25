#!/usr/bin/env python3
"""Free-GPU-memory checks that don't create a CUDA context.

Asking torch how much memory is free (`torch.cuda.mem_get_info`) creates a CUDA
context first, and on a small card that context alone costs a few hundred MiB,
which is the very memory the question was about. `nvidia-smi` reads the
driver's numbers from outside the process, so a worker can decide CPU-or-GPU
before it touches CUDA at all.
"""
from __future__ import annotations

import os
import subprocess
from typing import Callable


def free_gpu_mib(run: Callable[..., subprocess.CompletedProcess] = subprocess.run) -> int | None:
    """Free memory on GPU 0 in MiB, or None when it can't be read (no
    nvidia-smi, no NVIDIA GPU, unexpected output)."""
    try:
        out = run(
            ["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits", "--id=0"],
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
        ).stdout
        return int(out.strip().splitlines()[0])
    except Exception:  # noqa: BLE001 - unknown means "don't block on it"
        return None


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
