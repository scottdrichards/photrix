# Server Testing Framework

## Quick Start

Run tests at any time during development:

```bash
npm test                    # Run unit tests (fast)
npm run test:watch         # Run unit tests in watch mode
npm run test:all           # Run all tests (unit + integration)
npm run test:integration   # Run integration tests only
npm run test:coverage      # Generate coverage report
```

## Architecture

The test framework is split into two projects for fast feedback during development:

### Unit Tests (`npm test`)
- **Location:** `src/**/*.spec.ts` (excluding `main.spec.ts`)
- **Speed:** Fast (< 1s typically)
- **Purpose:** Test individual modules in isolation
- **Parallelization:** Tests run in parallel for speed

**Examples:**
- [src/common/standardHeights.spec.ts](src/common/standardHeights.spec.ts)
- [src/imageProcessing/convertImage.spec.ts](src/imageProcessing/convertImage.spec.ts)

### Integration Tests (`npm run test:integration`)
- **Location:** `src/main.spec.ts`
- **Speed:** Slower (requires server startup)
- **Purpose:** Test full HTTP server behavior and cross-module interactions
- **Parallelization:** Tests run serially (`--runInBand`) to avoid port conflicts

## Configuration Files

### jest.config.ts
Configures Jest with TypeScript support (ts-jest preset). Projects are defined here:
- **unit:** Fast, parallel unit tests
- **integration:** Serial integration tests with port isolation

### jest.setup.ts
Initializes test environment cache directories before any tests run:
- `ThumbnailCacheDirectory` → temp directory
- `INDEX_DB_LOCATION` → temp directory

This ensures tests don't pollute the actual storage paths.

## Writing Tests

### Unit Test Template
```typescript
import { describe, it, expect } from "@jest/globals";
import { myFunction } from "./myModule.ts";

describe("myFunction", () => {
  it("should handle valid input", () => {
    const result = myFunction({ foo: "bar" });
    expect(result).toBe(expectedValue);
  });
});
```

### Integration Test Template
See [src/main.spec.ts](src/main.spec.ts) for a full example:
- Server startup/teardown in `beforeEach` / `afterEach`
- HTTP request helpers
- Database initialization and cleanup

## Known Issues & Fixes

### Missing/Incorrect Exports
Several test files reference exports that don't exist or have moved:

- `fileUtils.spec.ts`: Looking for `toRelative` export (should be in main.spec.ts context)
- `fileScanner.spec.ts`: Looking for `FileScanner` export (class may have been removed or renamed)
- `main.spec.ts`: Importing `toRelative` which doesn't export from `fileHandling/fileUtils.ts`

**Status:** To be fixed by aligning test imports with actual module exports.

### Unused/Broken Tests
- `indexDatabase.spec.ts`: Tests call `db.load()` which doesn't exist (API mismatch)
- `fileUtils.spec.ts`: Tests assume metadata extraction behavior that may not be implemented

**Status:** To be fixed by either implementing missing APIs or removing tests for unimplemented features.

## Best Practices

Following the project's testing philosophy:

1. **High-level tests:** Focus on behavior and user experience, not implementation details
2. **Minimal mocking:** Mock only external dependencies (file system, database, etc.)
3. **Test specs, not code:** Tests should read like specifications of expected behavior
4. **Fast feedback:** Unit tests should run in seconds; integration tests in < 30s total

## CI/CD Integration

To run all tests in CI/CD pipelines:
```bash
npm run test:coverage
```

This generates a coverage report and ensures all tests pass before deployment.

## Debugging Tests

### Run a specific test file:
```bash
npm test -- src/common/standardHeights.spec.ts
```

### Run a specific test suite/case:
```bash
npm test -- --testNamePattern="myFunction"
```

### Debug with verbose output:
```bash
npm test -- --verbose
```

### Watch mode with focused file:
```bash
npm run test:watch -- src/imageProcessing/convertImage.spec.ts
```
