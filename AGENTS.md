# Testing Philosophy
- Tests should not be tied to implementation details and should be as high-level as appropriate. Tests should generally focus on the user experience or things that impact the user experience. Some systems may be complex
and the implementation details benefit from testing to manage their complexity.
- Tests should balance runtime with minimal mocking.

# Development
- If a prompt/interaction is testable, if possible create a test for it before implementing the solution, otherwise
create the test after implementation.
- If a prompt/interaction could be reflected in a prettier/linting change, suggest updating
those configurations.

# Coding style
- Concise code is preferred
- Prefer to inline single-use small functions
- Prefer to not use defaults unless there's a good reason to have one.
- Prefer to not "future-proof" or have backwards compatability - make it so the current version is
optimized for itself.