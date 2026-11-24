// Copies non-TypeScript runtime assets into the compiled tree.
//
// tsc only emits .js for .ts inputs, but a few modules resolve sibling assets
// relative to import.meta.url (rather than process.cwd()), so those assets must
// exist next to the emitted .js or the compiled server fails at runtime.
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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

// The shared packages are compiled into dist/shared/<name>/src by the same tsc
// run, but the server imports them by package name (`@photrix/filter-contract`).
// node would look that up in node_modules, where the workspace link points at
// TypeScript source. Give the compiled tree its own dist/node_modules/@photrix
// that points at the compiled files instead, so `node dist/...` needs nothing
// beyond the build.
const sharedRoot = resolve(serverRoot, "..", "shared");
for (const name of await readdir(sharedRoot)) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(resolve(sharedRoot, name, "package.json"), "utf8"));
  } catch {
    continue; // not a package (shared/assets)
  }
  const source = manifest.exports?.["."]?.default;
  if (typeof source !== "string") continue;
  const compiled = source.replace(/\.ts$/, ".js");
  const packageDir = resolve(serverRoot, "dist/node_modules", manifest.name);
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    resolve(packageDir, "package.json"),
    `${JSON.stringify({ name: manifest.name, type: "module", exports: "./index.js" }, null, 2)}\n`,
  );
  await writeFile(
    resolve(packageDir, "index.js"),
    `export * from "../../../shared/${name}/${compiled.replace(/^\.\//, "")}";\n`,
  );
  console.log(`linked ${manifest.name}`);
}
