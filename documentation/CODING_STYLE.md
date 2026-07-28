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
- Prefer single-export files except when multiple exports make sense, especially because the individual exports are so small or are related typings for the main export. The filename should match the single export (or main export if appropriate).
- Prefer to not use barrel files (they are largely uncessary abstraction)

- Always clean up as much as possible. If a method/export/etc. is no longer used, remove it.

# Standards

- Keep everything as up-to-date as possible with modern standards. Do not worry about supporting old systems.
