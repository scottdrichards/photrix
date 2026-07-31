// Copies non-TypeScript runtime assets into the compiled tree.
//
// tsc only emits .js for .ts inputs, but a few modules resolve sibling assets
// relative to import.meta.url (rather than process.cwd()), so those assets must
// exist next to the emitted .js or the compiled server fails at runtime.
import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// src-relative paths that must land in dist/server/src/<same path>.
const assets = ["imageProcessing/process_image.py"];

for (const asset of assets) {
  const from = resolve(serverRoot, "src", asset);
  const to = resolve(serverRoot, "dist/server/src", asset);
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to);
  console.log(`copied ${asset}`);
}
