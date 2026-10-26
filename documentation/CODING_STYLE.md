- Concise code is preferred, including a preference to fewer lines at the sacrifice of some clarity. It is better to foster legibility for the file as a whole at the expense of legibility for a particular line or function.
- Prefer to inline single-use small functions
- Prefer to not use defaults unless there's a good reason to have one.
- Prefer to not "future-proof" or have backwards compatability - make it so the current version is
  optimized for itself.
- Avoid fallbacks - they hide the real failure instead of fixing it, and turn a loud, findable
  error into a silent wrong behavior downstream. The same applies to broad `try`/`catch` that
  swallow errors. Prefer to fail fast and loud: validate assumptions up front (ideally at startup)
  and let the actual error surface. Only catch/recover when you can genuinely handle the failure and
  intend to (e.g. best-effort cleanup that is explicitly commented as such); never to paper over a
  missing dependency, config, or invariant. Resilience means surfacing root causes, not masking them.
- Avoid `try`/`catch`. Return errors and log them instead:
  - When the caller decides what a failure means (a file that may not exist, an
    optional lookup), return it as a value with `attempt` / `attemptSync`
    (`server/src/common/result.ts`, `client/src/result.ts`) and branch on `ok`.
    Handle the *expected* error (`isNotFound`, an abort) and log the rest — a
    catch written for the expected case must not hide every other one.
  - For work nothing awaits, attach `logFailure(...)` (`server/src/common/logFailure.ts`,
    `client/src/logFailure.ts`) so a failure is recorded rather than dropped.
  - Check a precondition rather than catch the error it would raise
    (`dialog.open` before `showModal()`, `hasPointerCapture` before releasing).
  - In a request handler, read the body with `readJsonRequest`, which answers a
    malformed request itself (400, or 413 when too large).
  - A catch that does nothing is a lint error (`no-restricted-syntax`): an empty
    `catch {}` block, or `.catch(() => {})` / `undefined` / `null` / `[]`.
- Prefer single-export files except when multiple exports make sense, especially because the individual exports are so small or are related typings for the main export. The filename should match the single export (or main export if appropriate).
- Prefer to not use barrel files (they are largely uncessary abstraction)

- Always clean up as much as possible. If a method/export/etc. is no longer used, remove it.

# Standards

- Keep everything as up-to-date as possible with modern standards. Do not worry about supporting old systems.
