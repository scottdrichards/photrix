#!/usr/bin/env python3
"""Unit tests for the GPU-first / CPU-fallback face runtime. Model-free."""
from __future__ import annotations

import unittest

from face_runtime import CPU_PROVIDER, FaceRuntime, is_gpu_resource_error

GPU = "CUDAExecutionProvider"
OOM = RuntimeError(
    "CUDNN failure 4000: CUDNN_STATUS_INTERNAL_ERROR ; expr=cudnnCreate(&cudnn_handle_);"
)


class Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


class Harness:
    """A factory that records builds, and apps whose GPU copy can be made to fail."""

    def __init__(self, provider: str = GPU, cooldown_s: float = 60.0) -> None:
        self.built: list[str] = []
        self.gpu_error: Exception | None = None
        self.clock = Clock()
        self.logs: list[str] = []
        self.runtime = FaceRuntime(
            provider,
            self._build,
            cooldown_s=cooldown_s,
            clock=self.clock,
            log=self.logs.append,
        )

    def _build(self, provider: str) -> str:
        self.built.append(provider)
        return provider

    def call(self) -> str:
        def fn(app: str) -> str:
            if app == GPU and self.gpu_error is not None:
                raise self.gpu_error
            return app

        return self.runtime.run(fn)


class FaceRuntimeTest(unittest.TestCase):
    def test_cpu_provider_never_builds_a_gpu_set(self) -> None:
        h = Harness(provider=CPU_PROVIDER)
        self.assertEqual(h.call(), CPU_PROVIDER)
        self.assertEqual(h.built, [CPU_PROVIDER])
        self.assertFalse(h.runtime.wants_gpu)

    def test_healthy_gpu_never_builds_a_cpu_copy(self) -> None:
        h = Harness()
        self.assertEqual([h.call(), h.call()], [GPU, GPU])
        self.assertEqual(h.built, [GPU])

    def test_gpu_resource_error_answers_on_cpu_and_releases_the_gpu(self) -> None:
        h = Harness()
        h.call()
        h.gpu_error = OOM
        self.assertEqual(h.call(), CPU_PROVIDER)
        self.assertFalse(h.runtime.gpu_loaded)
        self.assertTrue(any("using CPU for 60s" in line for line in h.logs))

    def test_reports_a_fallback_only_when_the_gpu_was_wanted(self) -> None:
        h = Harness()
        h.call()
        self.assertFalse(h.runtime.on_cpu_fallback)
        h.gpu_error = OOM
        h.call()
        self.assertTrue(h.runtime.on_cpu_fallback)
        h.clock.now += 61
        h.gpu_error = None
        h.call()
        self.assertFalse(h.runtime.on_cpu_fallback)

        cpu_only = Harness(provider=CPU_PROVIDER)
        cpu_only.call()
        self.assertEqual(cpu_only.runtime.last_device, "cpu")
        self.assertFalse(cpu_only.runtime.on_cpu_fallback)

    def test_yield_gpu_hands_over_and_cools_down(self) -> None:
        h = Harness()
        h.call()
        self.assertTrue(h.runtime.yield_gpu("CLIP needs the memory"))
        self.assertFalse(h.runtime.gpu_loaded)
        self.assertEqual(h.call(), CPU_PROVIDER)
        h.clock.now = 60.0
        self.assertEqual(h.call(), GPU)

    def test_yield_gpu_with_nothing_loaded_reports_false(self) -> None:
        self.assertFalse(Harness().runtime.yield_gpu("nothing to give"))
        self.assertFalse(Harness(provider=CPU_PROVIDER).runtime.yield_gpu("cpu only"))

    def test_cooldown_keeps_calls_on_cpu_then_rebuilds_the_gpu(self) -> None:
        h = Harness()
        h.gpu_error = OOM
        h.call()
        h.gpu_error = None
        h.clock.now = 59.0
        self.assertEqual(h.call(), CPU_PROVIDER)
        self.assertEqual(h.built.count(GPU), 1)  # not retried inside the cooldown
        h.clock.now = 60.0
        self.assertEqual(h.call(), GPU)
        self.assertEqual(h.built.count(GPU), 2)  # rebuilt after it
        self.assertEqual(h.built.count(CPU_PROVIDER), 1)  # CPU copy reused

    def test_non_resource_error_retries_on_cpu_but_keeps_the_gpu(self) -> None:
        h = Harness()
        h.gpu_error = ValueError("bad input shape")
        self.assertEqual(h.call(), CPU_PROVIDER)
        self.assertTrue(h.runtime.gpu_loaded)
        h.gpu_error = None
        self.assertEqual(h.call(), GPU)  # no cooldown

    def test_cpu_failure_propagates(self) -> None:
        h = Harness(provider=CPU_PROVIDER)

        def boom(_app: str) -> str:
            raise ValueError("corrupt image")

        with self.assertRaisesRegex(ValueError, "corrupt image"):
            h.runtime.run(boom)

    def test_gpu_load_failure_falls_back_too(self) -> None:
        h = Harness()

        def failing_build(provider: str) -> str:
            if provider == GPU:
                raise RuntimeError("Failed to allocate memory for requested buffer")
            return provider

        h.runtime._factory = failing_build
        self.assertEqual(h.call(), CPU_PROVIDER)

    def test_resource_error_classifier(self) -> None:
        for text in [
            "CUDA failure 2: out of memory",
            "CUDNN_FE failure 11: CUDNN_BACKEND_API_FAILED",
            "BFCArena::AllocateRawInternal Failed to allocate memory",
            "CUBLAS_STATUS_ALLOC_FAILED",
        ]:
            self.assertTrue(is_gpu_resource_error(RuntimeError(text)), text)
        self.assertFalse(is_gpu_resource_error(ValueError("image file is truncated")))


class GpuResourceErrorTest(unittest.TestCase):
    def test_every_provider_family_counts(self) -> None:
        for text in (
            "CUDA error: out of memory",
            "MPS backend out of memory (MPS allocated: 9 GB)",
            "DML: D3D12 device removed",
            "CoreML failed to compile model",
            "XPU out of memory",
            "MIOpen Error: miopenStatusAllocFailed",
        ):
            self.assertTrue(is_gpu_resource_error(RuntimeError(text)), text)

    def test_short_names_need_a_whole_word(self) -> None:
        self.assertFalse(is_gpu_resource_error(ValueError("bad timestamps in /photos/hip-hop.jpg")))
        self.assertFalse(is_gpu_resource_error(ValueError("cannot identify image file")))
        self.assertFalse(is_gpu_resource_error(OSError(r"C:\\photos\\mps\\a.jpg not found")))
        self.assertFalse(is_gpu_resource_error(OSError("/photos/xpu.jpg not found")))


if __name__ == "__main__":
    unittest.main()
