#!/usr/bin/env node
// Restores better-sqlite3's compiled addon from a shared cache instead of
// recompiling it in every git worktree.
//
// Why this exists: better-sqlite3 ships no prebuilt binary for this Node ABI
// (node-v115 is a 404 on the upstream release page), so installing it always
// falls back to a full node-gyp source build. `bun install` itself takes ~2s
// for the whole repo; that one rebuild took ~85s, i.e. 97% of the cost of
// setting up a fresh worktree. The addon depends only on the package version
// and the Node ABI/platform/arch, so it is safe to share across worktrees
// keyed on exactly those.
//
// Why this is NOT a postinstall hook: bun runs the root package's lifecycle
// scripts BEFORE it links dependencies into node_modules (the opposite of
// npm's ordering), so a root postinstall cannot see better-sqlite3 at all.
// It is instead invoked by `bun run bootstrap` and by the server's pre* hooks,
// both of which run after linking. better-sqlite3 is deliberately kept out of
// `trustedDependencies` so its own install script never triggers a rebuild.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "..");
const serverDir = path.join(repoRoot, "server");

// better-sqlite3 is a dependency of the `server` workspace, not of the root,
// so resolve it from there — under bun's isolated linker it is only reachable
// via server/node_modules.
let packageDir;
try {
  packageDir = path.dirname(
    require.resolve("better-sqlite3/package.json", { paths: [serverDir, repoRoot] }),
  );
} catch {
  console.warn("[native] better-sqlite3 not installed yet — run `bun install` first");
  process.exit(0);
}

const { version } = require(path.join(packageDir, "package.json"));
const key = `better-sqlite3-${version}-node-${process.versions.modules}-${process.platform}-${process.arch}.node`;
const cacheDir =
  process.env.PHOTRIX_NATIVE_CACHE ??
  path.join(os.homedir(), ".cache", "photrix", "native");
const cachedAddon = path.join(cacheDir, key);
const builtAddon = path.join(packageDir, "build", "Release", "better_sqlite3.node");

// Hard-link when possible so a restored addon costs no additional disk, and
// fall back to a copy when the cache and the worktree are on different
// filesystems (the same constraint bun's own hardlink backend has).
const materialize = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.rmSync(to, { force: true });
  try {
    fs.linkSync(from, to);
  } catch {
    fs.copyFileSync(from, to);
  }
};

// Populate the cache via a temp file + rename so two worktrees installing at
// once can never observe a half-written addon.
const store = (from) => {
  fs.mkdirSync(cacheDir, { recursive: true });
  const temp = `${cachedAddon}.${process.pid}.tmp`;
  fs.copyFileSync(from, temp);
  fs.renameSync(temp, cachedAddon);
};

if (fs.existsSync(builtAddon)) {
  if (!fs.existsSync(cachedAddon)) {
    store(builtAddon);
    console.log(`[native] cached ${key}`);
  }
  process.exit(0);
}

if (fs.existsSync(cachedAddon)) {
  materialize(cachedAddon, builtAddon);
  console.log(`[native] restored ${key} from cache`);
  process.exit(0);
}

console.log(`[native] building better-sqlite3@${version} (first time for this Node ABI)`);
const build = spawnSync("npx", ["--yes", "node-gyp", "rebuild", "--release"], {
  cwd: packageDir,
  stdio: "inherit",
});

if (build.status !== 0 || !fs.existsSync(builtAddon)) {
  console.error("[native] better-sqlite3 build failed");
  process.exit(1);
}

store(builtAddon);
console.log(`[native] cached ${key}`);
