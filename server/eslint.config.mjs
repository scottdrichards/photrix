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
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["**/*.{ts,tsx,js,jsx,mjs,cjs}"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.es2021,
      },
      parserOptions: {
        sourceType: "module",
        projectService: true,
      },
    },
    rules: {
      ...sharedRules,
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/switch-exhaustiveness-check": "error",
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
