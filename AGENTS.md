# Links
Review these files when implicated (relative to root)
- Testing: /TESTING.md
- Deployment/Setup: /GETTING_STARTED.md

# Agent interactions
- If a prompt/interaction is testable, create a test before implementation if possible. If not possible, inform the user and create one after implementation.
- If a prompt/interaction could be reflected in a prettier/linting change, suggest updating
those configurations.
- If a misunderstanding occurs, ensure the learnings are captured in documentation or comments
- Ensure agent contexts are concise and only relevant contexts are loaded. For example, don't put much information in this file, but put it in a file/comment/etc. close to the relevant file.
- Challenge the user if a prompt seems to go against any directive, best practice, or principle in the repository.

# Directive persistence
- Treat explicit user phrases like `always`, `never`, `from now on`, or `every time` as durable directive candidates (not one-off preferences).
- If the directive changes repository workflow or coding behavior, update `AGENTS.md` (or a referenced instruction file) in the same change so future agents inherit it.
- If the directive is user-personal and not repository policy, store it in user memory instead of repo instructions.
- When directive scope is unclear, ask once whether it should be repo-wide policy or session-only behavior.
- After applying a durable directive, briefly confirm where it was recorded.

@./documentation/CODING_STYLE.md