# Playback lab

Measures what someone watching a video actually experiences: time to first
frame, stalls, seek latency, quality switches. It drives the real hls.js, in
headless Chromium, against a real Photrix server that encodes on the fly, under
emulated network conditions.

It is **expensive** and **not part of `bun run test:e2e` or CI**. It needs a
working hardware encoder, generates ~2 GB of synthetic video on first run, and
takes about 20 minutes. Run it when you change anything on the video path
(`server/src/videoProcessing/`, the HLS branch of the files handler, the
viewer's hls.js setup) and compare the numbers before and after.

The fast, deterministic checks for the same behaviour live in the server's unit
suite (`hlsSession.spec.ts`, `generateMultibitrateHLS.spec.ts`) and run in CI.

## Running

```bash
bun run test:playback-lab                       # from the repo root
PHOTRIX_LAB_MEDIA=/some/dir bun run test:playback-lab   # keep the generated media elsewhere
```

| Variable | Default | Meaning |
|---|---|---|
| `PHOTRIX_LAB_MEDIA` | `e2e/playback-lab/.media` | where the synthetic clips live (generated if missing) |
| `PHOTRIX_LAB_PORT` | `3398` | the lab server's port |
| `PHOTRIX_LAB_LOG_LEVEL` | `info` | the lab server's log level |

The lab boots its own server on its own port, with its own throwaway index and
cache, auth off, background tasks off and CUDA hidden from its ML workers, so
it can run beside a normal instance without touching its library or its GPU
memory.

## Reading the results

Each scenario prints one `[lab]` line and writes the full trace to
`e2e/test-results/playback-lab/results/<scenario>.json`; the server's log is
`e2e/test-results/playback-lab/server.log`.

| Field | Meaning |
|---|---|
| `firstFrameMs` | start to first frame playing |
| `stalls`, `stalledMs`, `longestStallMs` | rebuffering after playback began (seek waits excluded) |
| `seekMs` | each seek, until playing again (`null` = never) |
| `fragTtfbP50` / `Max` | time to first byte per segment: mostly the server waiting on the encoder |
| `levels` | the heights hls.js switched to, in order |
| `emergencyAborts` | segments hls.js abandoned mid-load to drop a level |
| `errors` | hls.js error details; `FATAL` ones triggered the app's recovery |

Budgets are asserted with `expect.soft`, so one run reports every scenario
that misses. A miss is a finding to read, not automatically a regression: the
box doing the encoding may be busy.

## Scenarios

Short clip to the end; long clip; a 4K 60 fps 10-bit HEVC portrait clip (what a
phone records); seek far ahead; seek back after seeking ahead; switch quality up
by hand mid-stream; start below the link's real speed and let Auto climb; pause
past the server's per-encode idle window; a slow link; a jittery link; three
viewers at once (two of them in the same clip, far apart); two viewers on the
same clip 20 s apart.

`PHOTRIX_LAB_STOCK_ABR=1` runs the same scenarios with stock hls.js ABR (the
app's buffer settings, without `encoderAwareHls.ts` or the upswitch guard), for
an A/B of the client side.

The clips are generated from ffmpeg's test pattern (`media.ts`): nothing in
them is a real recording.

The player is the viewer's own code, not a copy: `player.ts` transpiles
`client/src/encoderAwareHls.ts` (hls.js config and ABR) and
`client/src/hlsAbrGuard.ts` (the upswitch guard) into the page next to hls.js,
and mirrors the viewer's error-recovery policy.
