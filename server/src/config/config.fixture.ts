// Tests change configuration through here, never through process.env.
import { CONFIG_OVERRIDE, loadConfig, type Config } from "./config.ts";

type Vars = Record<string, string | undefined>;
type Slot = { [CONFIG_OVERRIDE]?: { vars: Vars; config: Config } };
const slot = globalThis as Slot;

/**
 * Replaces config() for the rest of the test file (or until resetConfig) with
 * the process environment plus `vars`, merged over any earlier override. An
 * `undefined` value unsets that variable. Takes effect for modules already
 * imported and for ones imported later, even after jest.resetModules().
 */
export const overrideConfig = (vars: Vars): Config => {
  const merged = { ...slot[CONFIG_OVERRIDE]?.vars, ...vars };
  const config = loadConfig({ ...process.env, ...merged });
  slot[CONFIG_OVERRIDE] = { vars: merged, config };
  return config;
};

/** Drops every override: config() reads the process environment again. */
export const resetConfig = (): void => {
  delete slot[CONFIG_OVERRIDE];
};
