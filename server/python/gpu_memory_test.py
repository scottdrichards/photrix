#!/usr/bin/env python3
"""Unit tests for gpu_memory. No GPU needed: nvidia-smi is faked."""
from __future__ import annotations

import os
import subprocess
import unittest
from unittest import mock

from gpu_memory import free_gpu_mib, has_room, min_free_mib


def _fake(stdout: str = "", error: Exception | None = None):
    def run(*_args, **_kwargs):
        if error is not None:
            raise error
        return subprocess.CompletedProcess(args=[], returncode=0, stdout=stdout)

    return run


class GpuMemoryTest(unittest.TestCase):
    def test_parses_free_mib(self) -> None:
        self.assertEqual(free_gpu_mib(_fake("1309\n")), 1309)

    def test_unreadable_is_none(self) -> None:
        self.assertIsNone(free_gpu_mib(_fake(error=FileNotFoundError("nvidia-smi"))))
        self.assertIsNone(free_gpu_mib(_fake("[N/A]\n")))
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


if __name__ == "__main__":
    unittest.main()
