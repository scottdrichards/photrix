- Concise code is preferred, including a preference to fewer lines at the sacrifice of some clarity. It is better to foster legibility for the file as a whole at the expense of legibility for a particular line or function.
- Prefer to inline single-use small functions
- Prefer to not use defaults unless there's a good reason to have one.
- Prefer to not "future-proof" or have backwards compatability - make it so the current version is
optimized for itself.