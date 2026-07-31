"""Shared host-memory helper for the ML worker processes.

Loading a model reads hundreds of megabytes of weights through the heap on its
way to the GPU. Python frees those buffers, but glibc's allocator keeps the
pages: it only returns memory at the top of the heap, and long-lived allocations
made during the load sit above the freed blocks and pin them. The result is a
worker that reports a resident set several times the size of what it is actually
using once the weights are on the card.

Measured on the whisper worker (large-v3, int8_float16, CUDA):

    after import                 556 MB
    peak during load           3,625 MB
    steady state after load    2,229 MB
    after malloc_trim(0)         685 MB

Setting MALLOC_ARENA_MAX alone does not help — the memory is reclaimable, it
just needs an explicit trim to hand it back.
"""
import ctypes
import ctypes.util


def trim_heap() -> None:
    """Returns free heap pages to the OS. No-op where malloc_trim is unavailable.

    Call once after a model finishes loading, not per request: the point is to
    release the one-off load buffers, and running it on a hot path would cost a
    heap walk for nothing.
    """
    try:
        libc_name = ctypes.util.find_library("c") or "libc.so.6"
        libc = ctypes.CDLL(libc_name)
        # Absent on musl and on non-Linux platforms; both are fine to skip.
        trim = getattr(libc, "malloc_trim", None)
        if trim is not None:
            trim(0)
    except Exception:
        # Purely an optimization — never let it break a working worker.
        pass
