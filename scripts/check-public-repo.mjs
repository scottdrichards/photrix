#!/usr/bin/env node
// Fails when a change adds a private network address. This repository is
// public, so infrastructure details (LAN addresses, internal hosts) belong in
// the deployment's own config, not in code, comments, examples or tests.
// Only *added* lines are checked: the gate stops new leaks without failing
// every PR on addresses that predate it.
import { execFileSync } from "node:child_process";

const base = process.argv[2];
if (!base) throw new Error("usage: check-public-repo.mjs <base-ref>");

const privateAddress =
  /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/;

const diff = execFileSync("git", ["diff", "--unified=0", `${base}...HEAD`], {
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
});

let file = "";
const hits = [];
for (const line of diff.split("\n")) {
  if (line.startsWith("+++ ")) file = line.slice(6);
  else if (line.startsWith("+") && privateAddress.test(line)) hits.push(`${file}: ${line.slice(1).trim()}`);
}

if (hits.length > 0) {
  console.error("Private network addresses added in this change:\n" + hits.join("\n"));
  process.exit(1);
}
console.log("No private network addresses added.");
