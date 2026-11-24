// The typed readers config.ts is built from. Each one parses a variable,
// records a problem instead of throwing (so startup can list every bad
// variable at once), and records its documentation for `.env.example`.

/** Raw variables: `process.env` at startup, a literal in tests. */
export type Env = Readonly<Record<string, string | undefined>>;

export type EnvVarDoc = {
  section: string;
  name: string;
  help: string;
  /** Shown as the value in `.env.example`: the default, or an example. */
  example: string;
  /** Written uncommented in `.env.example`, as a starting value. */
  active: boolean;
};

export type EnvSectionDoc = { title: string; intro: string | undefined };

type Doc = {
  help: string;
  /** Overrides the default as the value shown in `.env.example`. */
  example?: string;
  active?: boolean;
};

export class ConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(
      `Invalid configuration (server/.env.example documents every variable):\n${issues
        .map((issue) => `  - ${issue}`)
        .join("\n")}`,
    );
    this.name = "ConfigError";
  }
}

/**
 * Parses a human-friendly size string ("10GB", "512mb", "1024") into bytes.
 * Plain numbers are treated as bytes. Returns null when the value is unset or
 * cannot be parsed.
 */
export const parseByteSize = (value: string | undefined): number | null => {
  if (!value) return null;
  const match = /^\s*([\d.]+)\s*(b|kb|mb|gb|tb)?\s*$/i.exec(value);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const unit = (match[2] ?? "b").toLowerCase();
  const multipliers: Record<string, number> = {
    b: 1,
    kb: 1024,
    mb: 1024 ** 2,
    gb: 1024 ** 3,
    tb: 1024 ** 4,
  };
  return Math.floor(amount * multipliers[unit]);
};

export const createEnvReader = (env: Env) => {
  const issues: string[] = [];
  const vars: EnvVarDoc[] = [];
  const sections: EnvSectionDoc[] = [];

  const record = (name: string, doc: Doc, shownDefault: string) => {
    vars.push({
      section: sections.at(-1)?.title ?? "",
      name,
      help: doc.help,
      example: doc.example ?? shownDefault,
      active: doc.active ?? false,
    });
  };
  /** Trimmed, with an empty value meaning unset. */
  const read = (name: string): string | undefined => env[name]?.trim() || undefined;
  const bad = (name: string, raw: string, expected: string) =>
    issues.push(`${name}: expected ${expected}, got "${raw}"`);

  /**
   * A number. `zero: "default"` keeps the long-standing `Number(x) || fallback`
   * reading, where 0 means "use the default"; `"value"` takes 0 literally.
   * Below `min` is an error, unless `belowMin: "default"` (the old
   * "positive, else the default" readers).
   */
  const number = (
    name: string,
    fallback: number,
    doc: Doc & {
      zero?: "default" | "value";
      min?: number;
      belowMin?: "error" | "default";
      integer?: boolean;
      max?: number;
      expected?: string;
    },
  ): number => {
    record(name, doc, String(fallback));
    const raw = read(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    const { zero = "default", min = 0, belowMin = "error", integer = false, max } = doc;
    const expected =
      doc.expected ??
      `${integer ? "an integer" : "a number"} >= ${min}${max === undefined ? "" : ` and <= ${max}`}`;
    if (!Number.isFinite(value) || (integer && !Number.isInteger(value))) {
      bad(name, raw, expected);
      return fallback;
    }
    if (value === 0 && zero === "default") return fallback;
    if (max !== undefined && value > max) {
      bad(name, raw, expected);
      return fallback;
    }
    if (value < min) {
      if (belowMin === "error") bad(name, raw, expected);
      return fallback;
    }
    return value;
  };

  return {
    issues,
    docs: { vars, sections },

    /** Starts a group of variables in `.env.example`. */
    section: (title: string, intro?: string) => {
      sections.push({ title, intro });
    },

    /** A non-secret string, trimmed; unset when empty. */
    optional: (name: string, doc: Doc): string | undefined => {
      record(name, doc, "");
      return read(name);
    },

    text: (name: string, fallback: string, doc: Doc): string => {
      record(name, doc, fallback);
      return read(name) ?? fallback;
    },

    /** Used verbatim and never echoed in an error. Unset when empty. */
    secret: (name: string, doc: Doc & { minLength?: number }): string | undefined => {
      record(name, doc, "");
      const value = env[name] || undefined;
      if (
        value !== undefined &&
        doc.minLength !== undefined &&
        value.length < doc.minLength
      ) {
        issues.push(`${name}: must be at least ${doc.minLength} characters`);
      }
      return value;
    },

    /** An absolute URL with any trailing slashes removed. */
    url: (name: string, doc: Doc): string | undefined => {
      record(name, doc, "");
      const raw = read(name);
      if (raw === undefined) return undefined;
      if (!URL.canParse(raw)) {
        bad(name, raw, "an absolute URL");
        return undefined;
      }
      return raw.replace(/\/+$/, "");
    },

    /** Milliseconds; 0 means the default. */
    ms: (name: string, fallback: number, doc: Doc) => number(name, fallback, doc),
    /** Milliseconds where 0 is a real value (usually "off"). */
    msOrZero: (name: string, fallback: number, doc: Doc) =>
      number(name, fallback, { ...doc, zero: "value" }),
    /** A whole number >= 1; 0 means the default. */
    count: (name: string, fallback: number, doc: Doc) =>
      number(name, fallback, { ...doc, integer: true, min: 1 }),
    /** A positive number; 0 or a negative value means the default. */
    positive: (name: string, fallback: number, doc: Doc) =>
      number(name, fallback, {
        ...doc,
        belowMin: "default",
        min: Number.MIN_VALUE,
        expected: "a positive number",
      }),
    /** Any number, 0 included. */
    real: (name: string, fallback: number, doc: Doc) =>
      number(name, fallback, {
        ...doc,
        zero: "value",
        min: -Infinity,
        expected: "a number",
      }),
    port: (name: string, fallback: number, doc: Doc) =>
      number(name, fallback, { ...doc, zero: "value", integer: true, max: 65_535 }),

    /** A byte count, or a size like "10GB". */
    bytes: (name: string, fallback: number, doc: Doc & { example: string }): number => {
      record(name, doc, String(fallback));
      const raw = read(name);
      if (raw === undefined) return fallback;
      const value = parseByteSize(raw);
      if (value === null) bad(name, raw, 'a byte count or a size like "10GB"');
      return value ?? fallback;
    },

    /** One of two words, case-insensitive. */
    flag: (
      name: string,
      fallback: boolean,
      words: [on: string, off: string],
      doc: Doc,
    ): boolean => {
      record(name, doc, fallback ? words[0] : words[1]);
      const raw = read(name);
      if (raw === undefined) return fallback;
      const word = raw.toLowerCase();
      if (word === words[0]) return true;
      if (word === words[1]) return false;
      bad(name, raw, `"${words[0]}" or "${words[1]}"`);
      return fallback;
    },

    oneOf: <T extends string>(
      name: string,
      values: readonly T[],
      fallback: T,
      doc: Doc,
    ): T => {
      record(name, doc, fallback);
      const raw = read(name);
      if (raw === undefined) return fallback;
      if ((values as readonly string[]).includes(raw)) return raw as T;
      bad(name, raw, `one of ${values.join(", ")}`);
      return fallback;
    },

    /**
     * Parsed by `parse`, which returns the value or the reason it is wrong.
     * `secret` keeps the raw value out of the error.
     */
    custom: <T>(
      name: string,
      doc: Doc & { secret?: boolean },
      parse: (raw: string) => { value: T } | { error: string },
    ): T | undefined => {
      record(name, doc, "");
      const raw = doc.secret ? env[name] || undefined : read(name);
      if (raw === undefined) return undefined;
      const result = parse(raw);
      if ("value" in result) return result.value;
      issues.push(
        doc.secret
          ? `${name}: ${result.error}`
          : `${name}: ${result.error}, got "${raw}"`,
      );
      return undefined;
    },

    /** Not read here: documented because a child process (a Python worker) reads it. */
    passthrough: (name: string, doc: Doc) => {
      record(name, doc, "");
    },

    /** A problem that spans variables. */
    problem: (issue: string) => {
      issues.push(issue);
    },
  };
};

export type EnvReader = ReturnType<typeof createEnvReader>;
