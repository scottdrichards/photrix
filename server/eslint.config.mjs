import path from "node:path";
import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";
import { moduleBoundaries } from "../eslint.boundaries.mjs";
import { sharedIgnores, sharedRules, sharedTestRules } from "../eslint.shared.mjs";

// Which module (a directory under src/) may import from which. A new
// cross-module import that is not listed here fails lint: either the code is in
// the wrong module, or the dependency is deliberate and belongs in this map.
// Read top to bottom it runs from the foundation to the composition root.
const modules = withConfig({
  // Parses the environment; imports nothing from src.
  config: [],
  observability: [],
  python: [],
  common: ["observability"],
  accel: ["python"],
  featureFlags: ["common"],
  feedback: ["common"],
  mcp: ["common"],
  taskOrchestrator: ["common", "observability"],
  backgroundTasks: ["taskOrchestrator"],
  auth: ["common", "observability"],
  faceDetection: ["common"],
  // Reaches up to systemStatus for one free-VRAM reading before an encode.
  videoProcessing: ["common", "observability", "taskOrchestrator", "systemStatus"],
  fileHandling: ["common", "videoProcessing"],
  // Pure lookups, no I/O: GPS to place words.
  places: ["common"],
  // People: faces as stored rows, clusters and their review, and the live identify API.
  // The two-way edge with indexDatabase is the composition seam: IndexDatabase
  // builds the face stores onto database.faces/.faceClusters, and people reads
  // the index plumbing (filterToSQL, row types, embedding codec).
  people: ["common", "observability", "faceDetection", "indexDatabase"],
  indexDatabase: ["common", "observability", "fileHandling", "faceDetection", "places", "people"],
  // Pipeline stages and features: each reads and writes the index.
  imageProcessing: ["common", "observability", "python", "taskOrchestrator", "videoProcessing", "indexDatabase"],
  imageAnalysis: ["common", "observability", "python", "accel", "taskOrchestrator", "faceDetection", "indexDatabase"],
  audioProcessing: ["common", "observability", "python", "taskOrchestrator", "imageAnalysis", "indexDatabase"],
  videoFaceAnalysis: ["common", "observability", "taskOrchestrator", "faceDetection", "videoProcessing", "imageAnalysis", "indexDatabase", "people"],
  // The stages the task runner drives that turn files on disk into index rows:
  // scan, file info, EXIF, places, face and moment clustering.
  pipeline: ["common", "observability", "taskOrchestrator", "fileHandling", "places", "imageProcessing", "indexDatabase"],
  // What the machine and the task queue are doing right now, for the status page and reports.
  systemStatus: ["common", "observability", "taskOrchestrator", "audioProcessing"],
  // Turns a share link's scope into the filter its requests are confined to.
  shareScope: ["indexDatabase", "imageAnalysis", "audioProcessing"],
  shareDescription: ["observability", "indexDatabase"],
  naturalLanguageSearch: ["observability", "indexDatabase", "shareDescription"],
  photoCaption: ["common", "observability", "shareDescription"],
  requestHandlers: [
    "common", "observability", "featureFlags", "taskOrchestrator", "auth", "videoProcessing", "fileHandling",
    "faceDetection", "people", "indexDatabase", "imageProcessing", "imageAnalysis", "audioProcessing", "shareDescription",
    "naturalLanguageSearch", "photoCaption", "systemStatus", "shareScope", "feedback",
  ],
  // main.ts, createServer.ts, createRoutes.ts: the composition root.
  "(root)": ["*"],
});

// Every module may read config/.
function withConfig(map) {
  return Object.fromEntries(
    Object.entries(map).map(([name, deps]) =>
      [name, name === "config" || deps.includes("*") ? deps : ["config", ...deps]],
    ),
  );
}

// Only config/ reads the environment, so every variable is parsed, validated
// and documented in one place (see config/config.ts). Tests override it with
// config/config.fixture.ts.
const processEnvAllowed = ["src/config/config.ts", "src/config/config.fixture.ts", "src/config/childEnv.ts"];

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
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
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
    files: ["src/**/*.ts"],
    ignores: processEnvAllowed,
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message:
            "Read configuration with config() from config/config.ts (add the variable there), spawn children with config/childEnv.ts, and override it in tests with config/config.fixture.ts.",
        },
      ],
    },
  },
  {
    // *.fixture.ts are test helpers shared between specs.
    files: ["**/*.{spec,test,fixture}.{ts,tsx,js,jsx}"],
    languageOptions: {
      globals: {
        ...globals.jest,
      },
    },
    rules: {
      ...sharedTestRules,
      // jest mocks are untyped by nature; these flag nearly every mock call.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/require-await": "off",
    },
  },
  moduleBoundaries({
    srcDir: path.join(import.meta.dirname, "src"),
    nested: [],
    modules,
  }),
  eslintConfigPrettier,
);
