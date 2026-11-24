# audioProcessing

The two audio stages of the background pipeline, each backed by one
long-lived Python worker in `server/python/`.

| File | What it owns |
| --- | --- |
| `whisperWorker.ts` | the Whisper speech-to-text worker (`python/whisper_worker.py`): spawn, request framing, duration-scaled timeouts |
| `processAudioTranscription.ts` | background stage: transcribes videos one at a time, stores `TranscriptSegment`s |
| `whisperRuntimeState.ts` | worker health (starting, ready, timeouts, exits) for the status page |
| `clapWorker.ts` | the CLAP audio/text embedding worker (`python/clap_worker.py`); `embedTextWithClap` serves search |
| `processAudioEmbedding.ts` | background stage: embeds each video's audio for "sounds like" search |

- Both stages cascade from `exifMetadata` (they need the duration), see
  `backgroundTasks/registerBackgroundTasks.ts`.
- Each worker is a single process that handles requests serially, so the
  stages dispatch one request at a time; queuing more only starts their
  timeouts early.
- The orchestrator may freeze a worker while a user request runs. Search goes
  through `withForegroundWorker`, so a query is never blocked by that.
- `PHOTRIX_DISABLE_AUDIO=1` turns both stages off (useful for local runs).
- Transcripts are served as `representation=transcript` by
  `requestHandlers/files/filesRequestHandler.ts`.
