# Task Orchestrator

Schedules all background and on-demand work on the box (image conversion, video
transcoding, metadata/EXIF indexing, the combined face+CLIP image-analysis pass,
audio transcription and embedding) so that **user requests stay responsive while
the backlog still makes steady progress.**

Files:

- `taskOrchestrator.ts` — the scheduler: queues, the resource model, the
  pressure/duty-cycle backoff, and the run loop.
- `taskController.ts` — a tiny pause/resume/cancel state machine that an
  individual long-running task (a "runner") uses at its own chunk boundaries.
- `systemLoad.ts` — the dynamic load gate (`isSystemOverloaded`) based on the
  1-minute load average normalized to CPU count.

## Concepts

### Tasks, runners, controllers

- A `Task` is a unit of work with a `name`, a `start()` factory, an optional
  `type` (drives the resource model) and an optional `priority` (`high` |
  `normal`, default `normal`).
- `start()` returns a `TaskRunner`: `onComplete()` (the promise the orchestrator
  awaits) plus optional `pause`/`resume`/`cancel`/`getStatus` hooks.
- Long runners (e.g. `processImageAnalysis`) drive a `TaskController` and only
  observe pause/cancel **at chunk boundaries** (`await ctrl.waitUntilResumed()` /
  `ctrl.checkCancelled()`), so pausing is cooperative — it never interrupts an
  in-flight item, it just stops the next one from starting.

### Queues (priority order)

`blocking` → `implied` → `background`. The run loop scans them in this order and
admits the first task whose resource requirements currently fit. `blocking` work
(serving a user request directly) is never subject to backoff.

### Resource model

`getResourceRequirements(type)` assigns each task type a notional fraction
(≤ 1.0) of `gpu`/`cpu`/`disk`/`network`. The loop only starts a task if its
requirements still fit under the cap, which bounds how much heavy work runs
concurrently. This is a *coarse admission gate*, not real measurement — the live
load gate (below) is the dynamic backstop.

> ⚠️ **Reservations are held while a task is paused.** A paused background runner
> still has its resources checked out, so a higher-priority task that needs those
> same resources can be delayed until the paused one resumes and finishes. The
> duty cycle (rather than a hard stop) keeps this from becoming indefinite
> starvation, but keep it in mind when tuning `getResourceRequirements`.

### Backoff = duty cycle, not a hard stop

Background/implied work always keeps making progress; under pressure it simply
pauses for part of each cycle. Two independent pressure sources, evaluated
**per-task-priority**:

| Source | Trigger | Who yields |
| --- | --- | --- |
| `userActive()` | a request was served within `ACTIVITY_COOLDOWN_MS` (2s) | **all** background/implied tasks, including `high` |
| `isOverloaded()` | normalized load > threshold (`PHOTRIX_LOAD_THRESHOLD`, default 0.9) | only `normal`-priority tasks |

When any running task is under pressure, the orchestrator runs a duty cycle:
`DUTY_ON_MS` running, `DUTY_OFF_MS` paused (both 2s, override via
`PHOTRIX_BG_DUTY_ON_MS` / `PHOTRIX_BG_DUTY_OFF_MS`). High-priority tasks (e.g.
the filesystem scan) ignore load-based backoff so foundational indexing never
stalls, but still yield to live user requests.

`setPerformBackgroundTasks(false)` is the separate **hard** off switch (operator
maintenance toggle); it owns the runners and overrides the duty cycle.

## Control flow

1. `addTask(task, queue)` pushes onto a queue and wakes the loop.
2. The loop (`await sleeping`) scans queues in priority order, skips
   pressured background/implied tasks during the OFF phase, and admits the first
   resource-fitting task. With nothing to run it sleeps until woken.
3. On admission it checks out resources, starts the runner, and on completion
   checks resources back in, removes the task, and wakes the loop.
4. `noteUserActivity()` (called by the HTTP layer for every non-polling request)
   extends `userActiveUntil` and reconciles the duty cycle so the backlog yields.

## Observability

- Task start/complete and failures are logged via the structured logger
  (`module: "TaskOrchestrator"`).
- `getBackgroundTaskStatus()` powers the status/SSE endpoint. Each runner's
  `getStatus()` is wrapped in `withTimeout` (`STATUS_TIMEOUT_MS`, 2s) so one
  slow/stuck task can't freeze the status endpoint for every client; a timeout
  surfaces as a per-task "Status unavailable" rather than a hung request.

## Gotchas for future changes

- Pausing is cooperative. A runner that never reaches a chunk boundary will not
  pause — keep chunks small.
- `getStatus()` is polled frequently (the status SSE stream); keep it cheap.
  Today it runs full-table-scan COUNT queries — see
  `requestHandlers/statusRequestHandler.ts`, which caches the payload across
  clients to bound DB load. Prefer cached/aggregated counts over new scans.
- Resource fractions are global and static; if you add a new heavy task type,
  budget its fractions against the existing ones so a single user conversion can
  still slip through.
