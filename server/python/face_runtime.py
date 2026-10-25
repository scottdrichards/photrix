#!/usr/bin/env python3
"""GPU-first face models with a per-call CPU fallback.

The face models can run on CUDA, but a small GPU is shared with other models
(CLIP, CLAP, Whisper) that load and unload on their own schedule. When the card
is full, ONNX Runtime does not fall back to the CPU by itself: session creation
usually succeeds, and the failure surfaces only when a model first *runs*
(`cudnnCreate ... CUDNN_STATUS_INTERNAL_ERROR`, `Failed to allocate memory`).
Left alone, that turns a busy GPU into "no faces found" — including on live
requests that must always answer.

`FaceRuntime.run(fn)` therefore:

* calls `fn(app)` on the GPU model set when one is configured and not cooling
  down;
* on **any** GPU-side exception, reruns the same call on a CPU model set, so the
  caller always gets a CPU answer rather than an error;
* when the error looks like a GPU resource failure, drops the GPU model set
  (handing its memory back) and leaves the GPU alone for `cooldown_s` before
  trying again — reloading is cheap, so the next attempt just rebuilds it.

The CPU model set is built only when first needed, so a healthy GPU never pays
for a second copy.

Model-free on purpose: the model factory, clock and logger are injected, so the
fallback rules are unit-testable without onnxruntime or a GPU.
"""
from __future__ import annotations

import gc
import re
import sys
import time
from typing import Callable, Generic, TypeVar

CPU_PROVIDER = "CPUExecutionProvider"

# Errors that mean "the GPU could not do this right now" rather than "this input
# is bad". Matched case-insensitively against the exception text.
_GPU_RESOURCE_ERROR = re.compile(
    r"cuda|cudnn|cublas|out of memory|failed to allocate|bfcarena", re.IGNORECASE
)

App = TypeVar("App")
T = TypeVar("T")


def is_gpu_resource_error(exc: BaseException) -> bool:
    return bool(_GPU_RESOURCE_ERROR.search(str(exc)))


def _stderr(message: str) -> None:
    print(message, file=sys.stderr)


class FaceRuntime(Generic[App]):
    def __init__(
        self,
        provider: str,
        factory: Callable[[str], App],
        *,
        cooldown_s: float = 300.0,
        clock: Callable[[], float] = time.monotonic,
        log: Callable[[str], None] = _stderr,
    ) -> None:
        self.provider = (provider or CPU_PROVIDER).strip()
        self._factory = factory
        self._cooldown_s = cooldown_s
        self._clock = clock
        self._log = log
        self._gpu_app: App | None = None
        self._cpu_app: App | None = None
        self._gpu_retry_at = 0.0

    @property
    def wants_gpu(self) -> bool:
        return self.provider != CPU_PROVIDER

    @property
    def gpu_loaded(self) -> bool:
        return self._gpu_app is not None

    def _gpu_available(self) -> bool:
        return self.wants_gpu and self._clock() >= self._gpu_retry_at

    def _cpu(self) -> App:
        if self._cpu_app is None:
            self._cpu_app = self._factory(CPU_PROVIDER)
        return self._cpu_app

    def _gpu(self) -> App:
        if self._gpu_app is None:
            self._gpu_app = self._factory(self.provider)
        return self._gpu_app

    def release_gpu(self) -> None:
        """Drop the GPU model set so its memory goes back to the driver."""
        if self._gpu_app is None:
            return
        self._gpu_app = None
        gc.collect()

    def yield_gpu(self, reason: str) -> bool:
        """Give the GPU up to a higher-priority model and stay on CPU for the
        cooldown. Returns whether there was anything to give up."""
        had_gpu = self._gpu_app is not None
        self.release_gpu()
        if self.wants_gpu:
            self._gpu_retry_at = self._clock() + self._cooldown_s
            self._log(f"face models using CPU for {self._cooldown_s:.0f}s: {reason}")
        return had_gpu

    def _on_gpu_failure(self, exc: BaseException) -> None:
        if not is_gpu_resource_error(exc):
            self._log(f"face GPU call failed, retrying on CPU: {exc}")
            return
        self.yield_gpu(f"GPU unavailable: {exc}")

    def run(self, fn: Callable[[App], T]) -> T:
        if self._gpu_available():
            try:
                return fn(self._gpu())
            except Exception as exc:  # noqa: BLE001 - always answer on CPU
                self._on_gpu_failure(exc)
        return fn(self._cpu())
