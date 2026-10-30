# Server tests

The repo-wide philosophy is in [/TESTING.md](../TESTING.md). This page is how
the server's jest suite works.

```bash
bun run test --forceExit                         # every src/**/*.spec.ts
bun run test src/createServer.spec.ts --forceExit  # one file
bun run test --forceExit -t "share link"         # by test name
```

- **Use the `test` script, not bare `jest`.** The server is ESM, and jest only
  loads it with `NODE_OPTIONS=--experimental-vm-modules`, which the script sets.
- **Pass `--forceExit`.** A worker or timer left open keeps jest alive after
  the run finishes.
- **A spec that opens an `IndexDatabase` closes it** (`await db.close()` in
  `finally` or `afterEach`); otherwise its SQLite workers outlive the test.
- **Spec files are not type-checked.** `tsconfig.json` excludes them and
  ts-jest runs with `isolatedModules`, so a spec can drift from the code it
  tests without a compile error. Run it.
- **Mock a module with `jest.unstable_mockModule` before importing it**, then
  `await import(...)` the code under test. `jest.spyOn` cannot patch an ES
  module export. A mocked module must provide every member the code under test
  uses: the mock outlives `jest.resetModules()`.
- **Use `exampleFolder`** for anything that needs real media. It is a small
  synthetic library; its fixtures carry fabricated EXIF only.

## Where to start reading

- [`src/createServer.spec.ts`](src/createServer.spec.ts) runs the real HTTP
  server over a three-file library: routing, the auth gate, and what a share
  link may reach.
- [`src/createRoutes.spec.ts`](src/createRoutes.spec.ts) checks that every
  route in the table is reachable.
