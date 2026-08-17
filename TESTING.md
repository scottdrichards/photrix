# Testing Guidance

## Philsophy
- Tests should not be tied to implementation details and should be as high-level as appropriate. Tests should generally focus on the user experience or things that impact the user experience. Some systems may be complex
and the implementation details benefit from testing to manage their complexity.
- Tests should balance having minimal mocking but good runtime.
- A test should read like a specification, outlining expectations for a component. The entire repo should be able to be recreated by just using tests.
- Code coverage is a good smell test to find places that might benefit from more testing - but a certain amount of code coverage should not be a target metric.

## Layers
- **Client unit** (`vitest`): `bun run --filter photrix-client test`
- **Server unit** (`jest`): `bun run test` (from repo root; integration: `bun run --filter server test:integration`)
- **End-to-end** (`Playwright`): `bun run test:e2e` — drives the real app in a
  browser against an isolated server+client (throwaway DB, `exampleFolder` library,
  auth disabled), so a UI/behavior change can be validated without a human. First
  run needs `bun run test:e2e:install`. See `e2e/README.md` for isolation details
  and how to add tests.

Tests still run under Jest (server) and Vitest (client) on Node, not `bun
test` — bun is only the package manager here (see `GETTING_STARTED.md`).

## Manual/local testing

When running the dev server by hand to poke at a feature (not via the e2e
suite), point it at `server/exampleFolder` instead of a real photo library:

```
MEDIA_ROOT=./exampleFolder bun run --filter server start
```

`exampleFolder` is a small, diverse fixture (Live Photos, an embedded
motion photo, GPS/camera/keyword-tag metadata, a burst/moment-cluster set, a
synthetic face-clustering set, nested album folders) purpose-built to
exercise real ingestion/analysis code paths without touching a real library.
This matters beyond convenience: face clusters, moment stacks, and
embeddings live in one shared index/DB per `MEDIA_ROOT`, so two people (or
agents) testing against the same real library at once will step on each
other's analysis state. Only point at a real library when the task
specifically needs real-world data that doesn't reproduce against the
fixture.

### Adding fixtures

Everything in `exampleFolder` is synthetic, and it needs to stay that way —
this folder ships in a public repository, so a file dropped in straight off a
phone or camera publishes whatever EXIF that device wrote (GPS coordinates,
serial numbers, owner name). Author fixture metadata by hand: invented
`Make`/`Model` strings, public-landmark coordinates, and no
`Artist`/`CameraOwnerName`/`BodySerialNumber`.

The four camera-shaped fixtures — `sewing-threads.heic`,
`subFolder/soundboard.heic`, `subFolder/20120803_160939.jpg`, and
`subFolder/grandchildFolder/1V7A4755.JPG` — are generated, and the generator
documents which structural property each one exists to cover (embedded
thumbnail present vs. absent, EXIF orientation, HEIC, live-photo pairing):

```
pip install piexif pillow pillow-heif
python3 server/scripts/make-example-fixtures.py .
```

It's deterministic — regenerating produces byte-identical files, so re-running
it on an unmodified checkout is a no-op.