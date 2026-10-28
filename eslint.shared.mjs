export const sharedIgnores = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "server/exampleFolder/**",
];

// A catch that does nothing hides the failure it caught, and every other
// failure that happens to land there too. Handle the error, log it
// (server: common/logFailure), or return it as a value (server: common/result).
// See documentation/CODING_STYLE.md.
const swallowMessage =
  "Don't swallow errors: handle the error, log it, or return it as a value (see CODING_STYLE.md).";
const catchCallback = "CallExpression[callee.property.name='catch'] > ArrowFunctionExpression";

export const sharedRules = {
  "no-restricted-syntax": [
    "error",
    { selector: "CatchClause > BlockStatement[body.length=0]", message: swallowMessage },
    { selector: `${catchCallback}[body.type='BlockStatement'][body.body.length=0]`, message: swallowMessage },
    { selector: `${catchCallback}[body.type='Identifier'][body.name='undefined']`, message: swallowMessage },
    { selector: `${catchCallback}[body.type='Literal'][body.raw='null']`, message: swallowMessage },
    { selector: `${catchCallback}[body.type='ArrayExpression'][body.elements.length=0]`, message: swallowMessage },
  ],
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
  // Tests deliberately discard rejections they assert on some other way.
  "no-restricted-syntax": "off",
  "@typescript-eslint/no-explicit-any": "off",
};