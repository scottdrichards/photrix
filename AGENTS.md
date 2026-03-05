# Testing Philosophy
- Tests should not be tied to implementation details and should be as high-level as appropriate. Tests should generally focus on the user experience or things that impact the user experience. Some systems may be complex
and the implementation details benefit from testing to manage their complexity.
- Tests should balance runtime with minimal mocking.

# Development
- If a prompt/interaction is testable, if possible create a test for it before implementing the solution, otherwise
create the test after implementation.

# Coding style
- Concise code is preferred