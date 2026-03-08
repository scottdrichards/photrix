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

@./documentation/CODING_STYLE.md