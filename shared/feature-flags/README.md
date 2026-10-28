# @photrix/feature-flags

The one list of feature flags, shared by client and server.

## Adding a flag

Add an entry to `featureFlags` in `src/featureFlags.ts`. That is the whole
registration: the server exposes it at `GET /api/feature-flags`, the status
panel lists it with a toggle, and both sides get a typed name.

- Server: `featureFlagStore.isEnabled("name")` — cheap, synchronous, safe to call
  in a hot loop. Use `onChange` when a running component must react at once.
- Client: `useFeatureFlag("name")`.

## Where a flag's value comes from

1. **Environment** — `PHOTRIX_FLAG_<NAME>` (`THUMBNAIL_BACKFILL` for
   `thumbnailBackfill`) set to `true` or `false` pins the flag for that
   deployment. Any other value is a startup error. A pinned flag can't be
   toggled at runtime; the UI shows it as locked.
2. **Override** — set at runtime by a signed-in user (not a share link) through
   `PUT /api/feature-flags/<name>` with `{ "enabled": true | false | null }`.
   Stored in the database, so it survives restarts. `null` clears it.
3. **Default** — the `default` in the definition.

Remove a flag once its feature is permanent: delete the entry and the checks.
