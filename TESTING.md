# Testing Guidance

## Philsophy
- Tests should not be tied to implementation details and should be as high-level as appropriate. Tests should generally focus on the user experience or things that impact the user experience. Some systems may be complex
and the implementation details benefit from testing to manage their complexity.
- Tests should balance having minimal mocking but good runtime.
- A test should read like a specification, outlining expectations for a component. The entire repo should be able to be recreated by just using tests.
- Code coverage is a good smell test to find places that might benefit from more testing - but a certain amount of code coverage should not be a target metric.