import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";
import { sharedIgnores, sharedRules, sharedTestRules } from "../eslint.shared.mjs";

export default tseslint.config(
  {
    ignores: sharedIgnores,
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,js,jsx,mjs,cjs}"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.es2021,
      },
      parserOptions: {
        sourceType: "module",
      },
    },
    rules: {
      ...sharedRules,
    },
  },
  {
    files: ["**/*.{spec,test}.{ts,tsx,js,jsx}"],
    languageOptions: {
      globals: {
        ...globals.jest,
      },
    },
    rules: {
      ...sharedTestRules,
    },
  },
  eslintConfigPrettier,
);