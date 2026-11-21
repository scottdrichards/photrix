import { afterAll, describe, expect, it } from "@jest/globals";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PathContainmentError,
  assertStrictlyInside,
  isPathInside,
  joinLibraryPath,
  parseLibraryPath,
  resolveInside,
  resolveMediaPath,
  verifyRealPathInside,
} from "./pathContainment.ts";

// Layout: <tmp>/library is the media root; <tmp>/outside holds a file that no
// request may reach; symlinks inside the library point at both.
const sandbox = mkdtempSync(path.join(os.tmpdir(), "photrix-containment-"));
const library = path.join(sandbox, "library");
const outside = path.join(sandbox, "outside");
mkdirSync(path.join(library, "album"), { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(path.join(library, "album", "photo.jpg"), "inside");
writeFileSync(path.join(library, "..foo.jpg"), "dotted name");
writeFileSync(path.join(outside, "secret.txt"), "secret");
symlinkSync(path.join(outside, "secret.txt"), path.join(library, "album", "escape.jpg"));
symlinkSync(outside, path.join(library, "escape-dir"));
symlinkSync(path.join(library, "album", "photo.jpg"), path.join(library, "album", "alias.jpg"));
symlinkSync(path.join(library, "loop-a"), path.join(library, "loop-b"));
symlinkSync(path.join(library, "loop-b"), path.join(library, "loop-a"));

afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

describe("isPathInside", () => {
  it("accepts the base itself and its descendants", () => {
    expect(isPathInside("/lib", "/lib")).toBe(true);
    expect(isPathInside("/lib", "/lib/a/b.jpg")).toBe(true);
  });

  it("accepts a child whose name merely starts with two dots", () => {
    expect(isPathInside("/lib", "/lib/..foo.jpg")).toBe(true);
  });

  it("rejects the parent, siblings and unrelated roots", () => {
    expect(isPathInside("/lib", "/")).toBe(false);
    expect(isPathInside("/lib", "/lib-other/a.jpg")).toBe(false);
    expect(isPathInside("/lib", "/etc/hostname")).toBe(false);
    expect(isPathInside("/lib/a", "/lib/b")).toBe(false);
  });
});

describe("parseLibraryPath", () => {
  it("canonicalises to the index form", () => {
    expect(parseLibraryPath("2023/trip/img.jpg")).toEqual({
      ok: true,
      relativePath: "/2023/trip/img.jpg",
    });
    expect(parseLibraryPath("/2023//trip/./img.jpg")).toEqual({
      ok: true,
      relativePath: "/2023/trip/img.jpg",
    });
  });

  it("treats a leading slash as the library root, not the filesystem root", () => {
    expect(parseLibraryPath("/etc/hostname")).toEqual({ ok: true, relativePath: "/etc/hostname" });
  });

  it("keeps legitimate unusual names intact", () => {
    for (const name of [
      "#2 Thankful (8).jpg",
      "50% off.jpg",
      "why? really.jpg",
      "..foo.jpg",
      "...jpg",
      "café ☕.heic",
      "a & b+c.jpg",
    ]) {
      expect(parseLibraryPath(`/album/${name}`)).toEqual({
        ok: true,
        relativePath: `/album/${name}`,
      });
    }
  });

  it.each([
    ["..", 403],
    ["../etc/hostname", 403],
    ["album/../../etc/hostname", 403],
    ["/album/..", 403],
    ["album\\..\\..\\etc\\hostname", 400],
    ["album/photo.jpg\0.png", 400],
    [" album/photo.jpg", 400],
    ["album/photo.jpg ", 400],
  ])("rejects %j with %i", (raw, status) => {
    expect(parseLibraryPath(raw)).toMatchObject({ ok: false, status });
  });
});

describe("joinLibraryPath", () => {
  it("joins exactly as path.join(root, subPath) did, so cache keys don't move", () => {
    const joined = joinLibraryPath(library, "album/photo.jpg");
    expect(joined).toEqual({
      ok: true,
      relativePath: "/album/photo.jpg",
      absolutePath: path.join(library, "album/photo.jpg"),
    });
  });
});

describe("verifyRealPathInside / resolveMediaPath", () => {
  it("resolves an ordinary file", async () => {
    const resolved = await resolveMediaPath(library, "/album/photo.jpg");
    expect(resolved).toMatchObject({ ok: true, relativePath: "/album/photo.jpg" });
  });

  it("resolves a file literally named ..foo.jpg at the root", async () => {
    expect(await resolveMediaPath(library, "..foo.jpg")).toMatchObject({ ok: true });
  });

  it("follows a symlink that stays inside the library, reporting its target", async () => {
    const real = await verifyRealPathInside(library, path.join(library, "album", "alias.jpg"));
    expect(real).toMatchObject({ ok: true, realRelativePath: "/album/photo.jpg" });
  });

  it("refuses a file symlink that points outside the library", async () => {
    expect(await resolveMediaPath(library, "album/escape.jpg")).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it("refuses a file under a directory symlink that points outside the library", async () => {
    expect(await resolveMediaPath(library, "escape-dir/secret.txt")).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it("refuses a symlink loop", async () => {
    expect(await resolveMediaPath(library, "loop-a")).toMatchObject({ ok: false, status: 403 });
  });

  it("answers 404 for a missing file and for a file 'under' a file", async () => {
    expect(await resolveMediaPath(library, "album/missing.jpg")).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(await resolveMediaPath(library, "album/photo.jpg/x")).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it("refuses traversal before touching the filesystem", async () => {
    // A root that doesn't exist would make realpath throw; the lexical check
    // must answer first.
    expect(await resolveMediaPath("/nonexistent-root", "../etc/hostname")).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it("works when the library root is itself reached through a symlink", async () => {
    const linkedRoot = path.join(sandbox, "linked-library");
    symlinkSync(library, linkedRoot);
    expect(await resolveMediaPath(linkedRoot, "album/photo.jpg")).toMatchObject({ ok: true });
    expect(await resolveMediaPath(linkedRoot, "album/escape.jpg")).toMatchObject({
      ok: false,
      status: 403,
    });
  });
});

describe("resolveInside / assertStrictlyInside", () => {
  it("joins plain child names", () => {
    expect(resolveInside("/cache/hls/720p", "segment_000.ts")).toBe(
      path.join("/cache/hls/720p", "segment_000.ts"),
    );
  });

  it.each(["../../etc/hostname", "..", ".", "", "a/b", "a\\b", "seg\0.ts", "/etc/hostname"])(
    "throws for the component %j",
    (name) => {
      expect(() => resolveInside("/cache/hls/720p", name)).toThrow(PathContainmentError);
    },
  );

  it("assertStrictlyInside refuses the base itself and anything outside", () => {
    expect(() => assertStrictlyInside("/cache", "/cache")).toThrow(PathContainmentError);
    expect(() => assertStrictlyInside("/cache", "/etc/hostname")).toThrow(PathContainmentError);
    expect(assertStrictlyInside("/cache", "/cache/a/b")).toBe("/cache/a/b");
  });
});
