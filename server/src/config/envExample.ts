import { describeEnv } from "./config.ts";

const HEADER = `# Photrix server configuration. Copy this file to .env and adjust it.
#
# Generated from server/src/config/config.ts by \`bun run --filter server env:example\`;
# edit the help text there, not here. A commented-out line shows the default,
# or an example where there is none.
`;

/** Wraps text into comment lines of at most 80 characters. */
const comment = (text: string): string[] => {
  const lines: string[] = [];
  let line = "#";
  for (const word of text.split(/\s+/)) {
    if (line.length + word.length + 1 > 80 && line !== "#") {
      lines.push(line);
      line = "#";
    }
    line += ` ${word}`;
  }
  return [...lines, line];
};

/** The contents of server/.env.example. */
export const renderEnvExample = (): string => {
  const { sections, vars } = describeEnv();
  const out = [HEADER];
  for (const { title, intro } of sections) {
    out.push(`# --- ${title} ---`, ...(intro ? ["#", ...comment(intro)] : []), "");
    for (const { name, help, example, active } of vars.filter(
      (v) => v.section === title,
    )) {
      out.push(...comment(help), `${active ? "" : "# "}${name}=${example}`, "");
    }
  }
  return out.join("\n");
};
