export const sharedIgnores = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "server/exampleFolder/**",
];

export const sharedRules = {
  "no-console": "off",
  "@typescript-eslint/no-explicit-any": "warn",
  "@typescript-eslint/no-unused-vars": [
    "warn",
    {
      varsIgnorePattern: "^_",
      argsIgnorePattern: "^_",
    },
  ],
};

export const sharedTestRules = {
  "@typescript-eslint/no-explicit-any": "off",
};