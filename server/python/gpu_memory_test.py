#!/usr/bin/env python3
"""Unit tests for gpu_memory. No GPU needed: nvidia-smi is faked."""
from __future__ import annotations

import os
import subprocess
import unittest
from unittest import mock

from gpu_memory import clap_gpu_plan, free_gpu_mib, gpu_memory_mib, has_room, min_free_mib


def _fake(stdout: str = "", error: Exception | None = None):
    def run(*_args, **_kwargs):
        if error is not None:
            raise error
        return subprocess.CompletedProcess(args=[], returncode=0, stdout=stdout)

    return run


class GpuMemoryTest(unittest.TestCase):
    def test_parses_free_and_total(self) -> None:
        self.assertEqual(gpu_memory_mib(_fake("1309, 2048\n")), (1309, 2048))
        self.assertEqual(free_gpu_mib(_fake("1309, 2048\n")), 1309)

    def test_unreadable_is_none(self) -> None:
        self.assertIsNone(free_gpu_mib(_fake(error=FileNotFoundError("nvidia-smi"))))
        self.assertIsNone(free_gpu_mib(_fake("[N/A], [N/A]\n")))
        self.assertEqual(gpu_memory_mib(_fake("1309\n")), (None, None))
        self.assertIsNone(free_gpu_mib(_fake("")))

    def test_has_room(self) -> None:
        self.assertTrue(has_room(1309, 1024))
        self.assertFalse(has_room(463, 1024))
        self.assertTrue(has_room(None, 1024))

    def test_min_free_mib_env_override(self) -> None:
        with mock.patch.dict(os.environ, {"X_MIN": "2048"}):
            self.assertEqual(min_free_mib("X_MIN", 1024), 2048)
        with mock.patch.dict(os.environ, {"X_MIN": "lots"}):
            self.assertEqual(min_free_mib("X_MIN", 1024), 1024)
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(min_free_mib("X_MIN", 1024), 1024)


CLIP_GPU = {"PHOTRIX_CLIP_DEVICE": "cuda"}
FACES_GPU = {**CLIP_GPU, "PHOTRIX_INSIGHTFACE_PROVIDER": "CUDAExecutionProvider"}


class ClapGpuPlanTest(unittest.TestCase):
    def test_small_card_with_faces_on_gpu_keeps_clap_on_cpu_even_when_empty(self) -> None:
        # The startup race: CLAP sees an empty 2 GiB card before CLIP and the
        # face models load. It must still leave the card to them.
        use_gpu, reason = clap_gpu_plan(FACES_GPU, 1995, 2048)
        self.assertFalse(use_gpu)
        self.assertIn("go first", reason)

    def test_small_card_without_face_gpu_still_gives_clap_the_gpu(self) -> None:
        self.assertEqual(clap_gpu_plan(CLIP_GPU, 1309, 2048), (True, ""))
        face_cpu = {**CLIP_GPU, "PHOTRIX_INSIGHTFACE_PROVIDER": "CPUExecutionProvider"}
        self.assertEqual(clap_gpu_plan(face_cpu, 1309, 2048), (True, ""))

    def test_big_card_fits_everything(self) -> None:
        self.assertEqual(clap_gpu_plan(FACES_GPU, 6000, 8192), (True, ""))

    def test_not_enough_free_right_now(self) -> None:
        use_gpu, reason = clap_gpu_plan(FACES_GPU, 463, 8192)
        self.assertFalse(use_gpu)
        self.assertIn("463 MiB GPU free", reason)

    def test_free_threshold_override(self) -> None:
        env = {**CLIP_GPU, "PHOTRIX_CLAP_MIN_FREE_GPU_MIB": "5000"}
        self.assertFalse(clap_gpu_plan(env, 1309, 8192)[0])

    def test_face_provider_falls_back_to_legacy_clip_provider_var(self) -> None:
        env = {**CLIP_GPU, "PHOTRIX_CLIP_PROVIDER": "CUDAExecutionProvider"}
        self.assertFalse(clap_gpu_plan(env, 1995, 2048)[0])

    def test_unreadable_memory_does_not_block(self) -> None:
        self.assertEqual(clap_gpu_plan(FACES_GPU, None, None), (True, ""))


if __name__ == "__main__":
    unittest.main()
