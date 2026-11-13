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
const modules = {
  observability: [],
  python: [],
  common: ["observability"],
  accel: ["python"],
  featureFlags: ["common"],
  mcp: ["common"],
  taskOrchestrator: ["common", "observability"],
  backgroundTasks: ["taskOrchestrator"],
  auth: ["common", "observability"],
  videoProcessing: ["common", "observability", "taskOrchestrator"],
  fileHandling: ["videoProcessing"],
  faceDetection: [],
  indexDatabase: ["common", "observability", "fileHandling", "faceDetection"],
  // Pipeline stages and features: each reads and writes the index.
  imageProcessing: ["common", "observability", "python", "taskOrchestrator", "videoProcessing", "indexDatabase"],
  imageAnalysis: ["common", "observability", "python", "accel", "taskOrchestrator", "faceDetection", "indexDatabase"],
  audioProcessing: ["common", "observability", "python", "taskOrchestrator", "imageAnalysis", "indexDatabase"],
  videoFaceAnalysis: ["common", "observability", "taskOrchestrator", "faceDetection", "videoProcessing", "imageAnalysis", "indexDatabase"],
  shareDescription: ["observability", "indexDatabase"],
  naturalLanguageSearch: ["observability", "indexDatabase", "shareDescription"],
  photoCaption: ["common", "observability", "shareDescription"],
  requestHandlers: [
    "common", "observability", "featureFlags", "taskOrchestrator", "auth", "videoProcessing", "fileHandling",
    "faceDetection", "indexDatabase", "imageProcessing", "imageAnalysis", "audioProcessing", "shareDescription",
    "naturalLanguageSearch", "photoCaption",
  ],
  // main.ts, createServer.ts, createRoutes.ts: the composition root.
  "(root)": ["*"],
};

// Known violations. Fix one, delete its line; do not add to this list.
const stagesInDatabase = "pipeline stage living in the persistence module";
const grandfathered = {
  "common/cacheUtils.ts -> videoProcessing": "clearing a file's cache closes HLS watchers",
  "observability/systemMetrics.ts -> common": "system metrics are not logging",
  "observability/systemMetrics.ts -> taskOrchestrator": "system metrics are not logging",
  "observability/systemMetrics.ts -> audioProcessing": "system metrics are not logging",
  "observability/buildDiagnosticsReport.ts -> taskOrchestrator": "the report is a composer, not logging",
  "faceDetection/identifyFaces.ts -> indexDatabase": "vector maths lives in the cluster engine",
  "fileHandling/fileUtils.ts -> indexDatabase": "ExifMetadata is declared by the database",
  "videoProcessing/getVideoMetadata.ts -> indexDatabase": "ExifMetadata is declared by the database",
  "auth/shareScope.ts -> indexDatabase": "share-filter resolution is not authentication",
  "auth/shareScope.ts -> imageAnalysis": "share-filter resolution is not authentication",
  "auth/shareScope.ts -> audioProcessing": "share-filter resolution is not authentication",
  "auth/shareFolderScope.ts -> indexDatabase": "share-filter resolution is not authentication",
  "indexDatabase/analysisStore.ts -> videoFaceAnalysis": "queue-cost types declared by the consumer",
  "indexDatabase/fileSystemScanFolder.ts -> taskOrchestrator": stagesInDatabase,
  "indexDatabase/processExifMetadata.ts -> taskOrchestrator": stagesInDatabase,
  "indexDatabase/processFaceClustering.ts -> taskOrchestrator": stagesInDatabase,
  "indexDatabase/processFileInfo.ts -> taskOrchestrator": stagesInDatabase,
  "indexDatabase/processMomentClustering.ts -> taskOrchestrator": stagesInDatabase,
  "indexDatabase/processMomentClustering.ts -> imageProcessing": stagesInDatabase,
};

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
    grandfathered,
  }),
  eslintConfigPrettier,
);
