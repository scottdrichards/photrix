# Links
Review these files when implicated
- Testing: /TESTING.md (at root)

# Agent interactions
- If a prompt/interaction is testable, create a test before implementation if possible. If not possible, inform the user and create one after implementation.
- If a prompt/interaction could be reflected in a prettier/linting change, suggest updating
those configurations.
- If a misunderstanding occurs, ensure the learnings are captured in documentation somewhere
- Ensure contexts are concise and only relevant contexts are loaded. For example, don't put much information in this file, but put it in a file/comment/etc. close to the relevant file.

# Coding style
- Concise code is preferred
- Prefer to inline single-use small functions
- Prefer to not use defaults unless there's a good reason to have one.
- Prefer to not "future-proof" or have backwards compatability - make it so the current version is
optimized for itself.
