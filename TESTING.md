# Testing Guidance

## Philsophy
- Tests should not be tied to implementation details and should be as high-level as appropriate. Tests should generally focus on the user experience or things that impact the user experience. Some systems may be complex
and the implementation details benefit from testing to manage their complexity.
- Tests should balance having minimal mocking but good runtime.
- A test should read like a specification, outlining expectations for a component. The entire repo should be able to be recreated by just using tests.
- Code coverage is a good smell test to find places that might benefit from more testing - but a certain amount of code coverage should not be a target metric.

## Layers
- **Client unit** (`vitest`): `npm --prefix client test`
- **Server unit** (`jest`): `npm --prefix server test` (integration: `npm --prefix server run test:integration`)
- **End-to-end** (`Playwright`): `npm run test:e2e` — drives the real app in a
  browser against an isolated server+client (throwaway DB, `exampleFolder` library,
  auth disabled), so a UI/behavior change can be validated without a human. First
  run needs `npm run test:e2e:install`. See `e2e/README.md` for isolation details
  and how to add tests.

## Manual/local testing

When running the dev server by hand to poke at a feature (not via the e2e
suite), point it at `server/exampleFolder` instead of a real photo library:

```
MEDIA_ROOT=./exampleFolder npm --prefix server run start
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