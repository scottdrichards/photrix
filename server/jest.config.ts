import type { JestConfigWithTsJest } from "ts-jest";

const sharedConfig: JestConfigWithTsJest = {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        useESM: true,
        tsconfig: {
          isolatedModules: true,
        },
        diagnostics: {
          ignoreCodes: [151002],
        },
      },
    ],
  },
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
  testPathIgnorePatterns: ["<rootDir>/dist/"],
};

const config: JestConfigWithTsJest = {
  projects: [
    {
      ...sharedConfig,
      displayName: "unit",
      testMatch: ["<rootDir>/src/**/*.spec.ts"],
      testPathIgnorePatterns: ["<rootDir>/dist/", "<rootDir>/src/main.spec.ts"],
    },
    {
      ...sharedConfig,
      displayName: "integration",
      testMatch: ["<rootDir>/src/main.spec.ts"],
    },
  ],
};

export default config;
