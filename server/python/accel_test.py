"""Device selection with fake torch modules, so it runs on any machine."""
import types
import unittest

from accel import (
    CPU_PROVIDER,
    empty_cache,
    is_gpu_device,
    is_gpu_provider,
    pick_ort_provider,
    pick_torch_device,
    torch_backend_name,
)


class _Tensor:
    def __init__(self, fail: str | None) -> None:
        self._fail = fail

    def __matmul__(self, other):
        if self._fail:
            raise RuntimeError(self._fail)
        return self

    def sum(self):
        return self

    def item(self):
        return 1.0


def fake_torch(available=(), failing=None, hip=None):
    """A torch stand-in. `available`: devices whose is_available() is True.
    `failing`: device -> error text raised by the first real op on it."""
    failing = failing or {}
    calls = []

    def backend(name):
        return types.SimpleNamespace(
            is_available=lambda: name in available,
            empty_cache=lambda: calls.append(("empty_cache", name)),
        )

    def randn(*_shape, device):
        calls.append(("randn", device))
        return _Tensor(failing.get(device))

    torch = types.SimpleNamespace(
        cuda=backend("cuda"),
        xpu=backend("xpu"),
        mps=backend("mps"),
        backends=types.SimpleNamespace(mps=backend("mps")),
        version=types.SimpleNamespace(hip=hip),
        randn=randn,
        calls=calls,
    )
    return torch


class PickTorchDeviceTest(unittest.TestCase):
    def test_no_gpu_is_cpu(self) -> None:
        device, rejected = pick_torch_device(fake_torch())
        self.assertEqual(device, "cpu")
        self.assertEqual(set(rejected), {"cuda", "xpu", "mps"})

    def test_first_working_device_wins(self) -> None:
        self.assertEqual(pick_torch_device(fake_torch(available={"mps"}))[0], "mps")
        self.assertEqual(pick_torch_device(fake_torch(available={"xpu", "mps"}))[0], "xpu")
        self.assertEqual(pick_torch_device(fake_torch(available={"cuda", "xpu"}))[0], "cuda")

    def test_available_but_unusable_is_rejected_with_the_reason(self) -> None:
        # The P520 under an unpinned torch: is_available() True, every op fails.
        torch = fake_torch(
            available={"cuda"},
            failing={"cuda": "CUDA error: no kernel image is available for execution on the device"},
        )
        device, rejected = pick_torch_device(torch)
        self.assertEqual(device, "cpu")
        self.assertIn("no kernel image", rejected["cuda"])

    def test_falls_through_to_the_next_device(self) -> None:
        torch = fake_torch(available={"cuda", "mps"}, failing={"cuda": "driver too old"})
        self.assertEqual(pick_torch_device(torch)[0], "mps")

    def test_a_full_card_still_counts(self) -> None:
        # Busy now, usable later; the workers have their own OOM fallbacks.
        torch = fake_torch(available={"cuda"}, failing={"cuda": "CUDA out of memory. Tried to allocate"})
        self.assertEqual(pick_torch_device(torch)[0], "cuda")

    def test_rocm_is_reported_as_such(self) -> None:
        torch = fake_torch(available={"cuda"}, hip="6.4")
        self.assertEqual(torch_backend_name(torch, "cuda"), "rocm")
        self.assertEqual(torch_backend_name(fake_torch(), "cuda"), "cuda")
        self.assertEqual(torch_backend_name(torch, "cpu"), "cpu")

    def test_a_torch_without_xpu_or_mps_is_fine(self) -> None:
        torch = types.SimpleNamespace(
            cuda=types.SimpleNamespace(is_available=lambda: False),
            randn=lambda *a, **k: _Tensor(None),
        )
        self.assertEqual(pick_torch_device(torch)[0], "cpu")


class PickOrtProviderTest(unittest.TestCase):
    def test_prefers_cuda_then_the_others(self) -> None:
        self.assertEqual(
            pick_ort_provider(["CPUExecutionProvider", "CUDAExecutionProvider", "TensorrtExecutionProvider"]),
            "CUDAExecutionProvider",
        )
        self.assertEqual(
            pick_ort_provider(["CoreMLExecutionProvider", "CPUExecutionProvider"]),
            "CoreMLExecutionProvider",
        )
        self.assertEqual(
            pick_ort_provider(["DmlExecutionProvider", "CPUExecutionProvider"]),
            "DmlExecutionProvider",
        )

    def test_tensorrt_alone_is_not_picked(self) -> None:
        self.assertEqual(
            pick_ort_provider(["TensorrtExecutionProvider", "CPUExecutionProvider"]),
            CPU_PROVIDER,
        )

    def test_cpu_only(self) -> None:
        self.assertEqual(pick_ort_provider(["CPUExecutionProvider"]), CPU_PROVIDER)
        self.assertEqual(pick_ort_provider([]), CPU_PROVIDER)


class HelpersTest(unittest.TestCase):
    def test_is_gpu(self) -> None:
        for device in ("cuda", "xpu", "mps", "CUDA "):
            self.assertTrue(is_gpu_device(device))
        for device in ("cpu", "", None):
            self.assertFalse(is_gpu_device(device))
        self.assertTrue(is_gpu_provider("CoreMLExecutionProvider"))
        self.assertFalse(is_gpu_provider(CPU_PROVIDER))

    def test_empty_cache_targets_the_device(self) -> None:
        torch = fake_torch()
        empty_cache(torch, "mps")
        empty_cache(torch, "cpu")
        empty_cache(torch, None)
        self.assertEqual(torch.calls, [("empty_cache", "mps")])

    def test_empty_cache_without_the_backend_is_a_no_op(self) -> None:
        empty_cache(types.SimpleNamespace(), "xpu")


if __name__ == "__main__":
    unittest.main()
