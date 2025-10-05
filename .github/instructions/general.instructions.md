---
applyTo: '**/*.js, **/*.jsx, **/*.ts, **/*.tsx, **/*.mjs, **/*.cjs'
---
# Javascript/Typescript General Instructions
- Prefer modern JavaScript/TypeScript syntax and features.
- Prefer immutable data structures and pure functions.
- Avoid mutating objects or arrays directly unless necessary.
- Use functional paradigms as much as possible. Instead of iterating over an array with a for loop and a mutable accumulator, prefer using array methods like map, filter, and reduce.
- Avoid "let" unless necessary.
- Prefer async/await over Promises and callbacks for asynchronous code.
- Classes should only be used to avoid complexities surrounding shared state and mutability is inevitable. For example, a database could be a class.
- Arrow functions are preferred over function declarations and expressions.
- Use template literals instead of string concatenation.
- Prefer `type` to `interface`
- Use destructuring assignment to extract values from objects and arrays.
- Use optional chaining and nullish coalescing to handle undefined or null values.
- Each file should have one purpose. Avoid "utils" or helper functions. Each file should have one export.
- Test files should be adjacent to the file under test unless they are end-to-end tests.
- Tests should be treated as specifications. Do not test implementation details. Avoid mocking unless necessary.
- Keep files short.
- Always refactor code to be simpler when possible.
- If adding a non-complex feature requires a lot of complex code, that is an indicator that the existing framework should be refactored first.

# Function organization and structure
- The longest path should be the happiest path. The final return should relate to the purpose of the function (and likely the name of it). All other code should be to validate inputs, handle errors, and prepare for the final return.
- Do not abstract unecessarily. If a function is only used once, and is not complex, consider inlining it.
- If it is challenging to find a simple name for a function, that is an indicator that the function is doing too much and should be broken up.
- Functions should avoid nesting and complexity. The general form should be validate, execute, return. "Else" statements should be avoid in favor of early returns.
- If a method doesn't reference class state (no "this.") then it should be extracted as an independent function


# General Principles
- Code should be first: easy to understand (brief and legible), next easy to maintain/change, and last performant.
- Use descriptive and meaningful variable and function names.
- Avoid comments that are on the same level of complexity of the code they describe. For example, a function named addTwoNumbers should not have a comment saying "This function adds two numbers".
- Functions should not try to overcome failed assumptions. Avoid casting and swallowing errors. Fail fast and loudly. Avoid default parameters that might hide errors.
- Iterate slowly and refactor often.
- Avoid premature optimization. First make it work, then make it right, then make it fast.
- Add basic logging, especially for long-running tasks (like indexing or converting a file) so that a user can see progress. Also add logging for critical operations (like saving a file or sending a network request) so that errors can be diagnosed.
