import path from "node:path";
import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import jsxA11y from "eslint-plugin-jsx-a11y";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";
import { moduleBoundaries } from "../eslint.boundaries.mjs";
import { sharedIgnores, sharedRules, sharedTestRules } from "../eslint.shared.mjs";

// Which module may import from which: a directory under src/, or under
// src/components/. A new cross-module import that is not listed here fails
// lint. "(root)" is the loose files in src/, which today mix the app shell
// (App.tsx) with foundations everything uses (auth.ts, result.ts), so every
// module may import them.
const modules = {
  "(root)": ["*"],
  api: ["(root)"],
  featureFlags: ["(root)"],
  hooks: ["(root)", "api", "components/filter"],
  components: ["(root)"],
  "components/selection": ["(root)", "components"],
  "components/share": ["(root)", "api"],
  "components/feedback": ["(root)", "api"],
  "components/status": ["(root)", "components", "featureFlags"],
  "components/account": ["(root)", "api", "hooks", "components"],
  "components/map": ["(root)"],
  "components/people": ["(root)", "api", "hooks", "components", "components/selection"],
  "components/filter": ["(root)", "components/map", "components/people"],
  "components/search": ["(root)", "api", "components/filter"],
  "components/grid": [
    "(root)", "api", "hooks", "components", "components/selection", "components/search",
    "components/filter", "components/share",
  ],
  "components/viewer": [
    "(root)", "api", "hooks", "components", "components/selection", "components/people",
    "components/grid", "components/share", "components/filter", "components/map",
  ],
};

// Known violations. Fix one, delete its line; do not add to this list.
const filterContext = "FilterContext lives in the filter panel's folder, which also renders this module";
const grandfathered = {
  "api/share.ts -> hooks": "buildShareUrl is not a hook",
  "components/grid/ThumbnailTile.tsx -> components/viewer": "edit rendering lives inside the viewer",
  "components/map/MapFilter.tsx -> components/filter": filterContext,
  "components/people/PeopleView.tsx -> components/filter": filterContext,
};

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
        ...globals.browser,
        ...globals.es2021,
      },
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
        sourceType: "module",
      },
    },
    plugins: {
      react,
      "react-hooks": reactHooks,
      "jsx-a11y": jsxA11y,
    },
    settings: {
      react: {
        version: "detect",
      },
    },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.configs.recommended.rules,
      ...sharedRules,
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
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
  moduleBoundaries({
    srcDir: path.join(import.meta.dirname, "src"),
    nested: ["components"],
    modules,
    grandfathered,
  }),
  eslintConfigPrettier,
);
