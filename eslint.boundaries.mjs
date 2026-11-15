import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = "(root)";
const SOURCE_EXTENSIONS = [".ts", ".tsx"];

/**
 * The module a source file belongs to: its top-level directory under `srcDir`,
 * one level deeper for the directories named in `nested`, or `(root)` for a
 * file directly in `srcDir`. Null when the file is outside `srcDir`.
 */
const moduleOfFile = (file, srcDir, nested) => {
  const relative = path.relative(srcDir, file);
  if (relative.startsWith("..")) return null;
  const directories = relative.split(path.sep).slice(0, -1);
  if (directories.length === 0) return ROOT;
  return nested.includes(directories[0]) && directories.length > 1
    ? `${directories[0]}/${directories[1]}`
    : directories[0];
};

// `../api` is `api.ts` when that file exists and `api/index.ts` otherwise.
const resolveImport = (fromFile, source) => {
  const target = path.resolve(path.dirname(fromFile), source.replace(/\.jsx?$/, ""));
  if (path.extname(target)) return target;
  const extension = SOURCE_EXTENSIONS.find((candidate) => existsSync(target + candidate));
  return extension ? target + extension : path.join(target, "index.ts");
};

/**
 * Fails an import that crosses from one module into another unless `modules`
 * allows that direction.
 *
 * Options:
 * - `srcDir`: absolute path of the source root.
 * - `nested`: top-level directories whose subdirectories are modules themselves.
 * - `modules`: module name -> the modules it may import from (`"*"` for any).
 * - `grandfathered`: `"<file relative to srcDir> -> <module>"` -> why it is
 *   still there. Known violations awaiting a fix; an entry that no longer
 *   matches an import is itself an error, so the list can only shrink.
 */
const rule = {
  meta: {
    type: "problem",
    schema: [
      {
        type: "object",
        properties: {
          srcDir: { type: "string" },
          nested: { type: "array", items: { type: "string" } },
          modules: { type: "object" },
          grandfathered: { type: "object" },
        },
        required: ["srcDir", "nested", "modules", "grandfathered"],
        additionalProperties: false,
      },
    ],
    messages: {
      unknownModule:
        "'{{module}}' is not listed in the module boundaries. Add it, with the modules it may import from, to this workspace's eslint.config.mjs.",
      forbidden:
        "'{{from}}' may not import from '{{to}}'. Move the code so the dependency points the allowed way, or, if this direction is right, allow it in this workspace's eslint.config.mjs.",
      staleGrandfather:
        "'{{key}}' is grandfathered in eslint.config.mjs but this file no longer imports from '{{to}}'. Delete the entry.",
    },
  },
  create: (context) => {
    const [{ srcDir, nested, modules, grandfathered }] = context.options;
    const from = moduleOfFile(context.filename, srcDir, nested);
    if (from === null) return {};
    if (!(from in modules))
      return {
        Program: (node) =>
          context.report({ node, messageId: "unknownModule", data: { module: from } }),
      };
    const relativeFile = path.relative(srcDir, context.filename).split(path.sep).join("/");
    const usedGrandfathers = new Set();

    const check = (node) => {
      const source = node.source?.value;
      if (typeof source !== "string" || !source.startsWith(".")) return;
      const to = moduleOfFile(resolveImport(context.filename, source), srcDir, nested);
      if (to === null || to === from) return;
      const allowed = modules[from];
      if (allowed.includes("*") || allowed.includes(to)) return;
      const key = `${relativeFile} -> ${to}`;
      if (key in grandfathered) return void usedGrandfathers.add(key);
      context.report({ node: node.source, messageId: "forbidden", data: { from, to } });
    };

    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
      ImportExpression: check,
      "Program:exit": (node) =>
        Object.keys(grandfathered)
          .filter((key) => key.startsWith(`${relativeFile} -> `) && !usedGrandfathers.has(key))
          .forEach((key) =>
            context.report({
              node,
              messageId: "staleGrandfather",
              data: { key, to: key.split(" -> ")[1] },
            }),
          ),
    };
  },
};

/**
 * A flat-config entry enforcing module boundaries on a workspace's production
 * source. Tests and fixtures are exempt: they reach across modules to set up
 * the thing under test.
 */
export const moduleBoundaries = (options) => ({
  files: ["src/**/*.{ts,tsx}"],
  ignores: ["**/*.{spec,test,fixture}.{ts,tsx}", "src/test/**"],
  plugins: { photrix: { rules: { "module-boundaries": rule } } },
  rules: { "photrix/module-boundaries": ["error", options] },
});
