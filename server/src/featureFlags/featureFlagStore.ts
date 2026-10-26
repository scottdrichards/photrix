import type { AsyncSqlite } from "../common/asyncSqlite.ts";
import {
  featureFlagEnvironmentVariable,
  featureFlags,
  isFeatureFlagName,
  type FeatureFlagName,
  type FeatureFlagState,
} from "../../../shared/feature-flags/src/featureFlags.ts";

const SETTING_PREFIX = "featureFlag.";
const flagNames = Object.keys(featureFlags) as FeatureFlagName[];

export class FeatureFlagPinnedError extends Error {}

/**
 * Resolves feature flags (environment pin → stored override → default) and
 * keeps them in memory, so `isEnabled` is synchronous and free to call from a
 * hot loop. Overrides live in the `settings` table and survive restarts.
 */
export class FeatureFlagStore {
  private readonly pinned = new Map<FeatureFlagName, boolean>();
  private readonly overrides = new Map<FeatureFlagName, boolean>();
  private readonly listeners = new Map<FeatureFlagName, Set<(enabled: boolean) => void>>();

  private constructor(private readonly db: AsyncSqlite) {}

  /** Reads pins from `env` (failing on a malformed value) and overrides from the database. */
  static async load(db: AsyncSqlite, env: NodeJS.ProcessEnv): Promise<FeatureFlagStore> {
    const store = new FeatureFlagStore(db);
    for (const name of flagNames) {
      const variable = featureFlagEnvironmentVariable(name);
      const raw = env[variable];
      if (raw === undefined) continue;
      if (raw !== "true" && raw !== "false") {
        throw new Error(`${variable} must be "true" or "false", not "${raw}"`);
      }
      store.pinned.set(name, raw === "true");
    }

    const rows = await db.all<{ key: string; value: string }>(
      "SELECT key, value FROM settings WHERE key LIKE ? ESCAPE '\\'",
      `${SETTING_PREFIX.replace(/[%_\\]/g, "\\$&")}%`,
    );
    for (const { key, value } of rows) {
      const name = key.slice(SETTING_PREFIX.length);
      // An override for a flag that has since been removed: clean it up.
      if (!isFeatureFlagName(name)) await db.run("DELETE FROM settings WHERE key = ?", key);
      else store.overrides.set(name, JSON.parse(value) === true);
    }
    return store;
  }

  isEnabled(name: FeatureFlagName): boolean {
    return this.pinned.get(name) ?? this.overrides.get(name) ?? featureFlags[name].default;
  }

  list(): FeatureFlagState[] {
    return flagNames.map((name) => ({
      name,
      enabled: this.isEnabled(name),
      source: this.pinned.has(name) ? "environment" : this.overrides.has(name) ? "override" : "default",
      description: featureFlags[name].description,
    }));
  }

  /** Sets a runtime override, or clears it with `null`. A pinned flag can't be overridden. */
  async setOverride(name: FeatureFlagName, enabled: boolean | null): Promise<void> {
    if (this.pinned.has(name)) {
      throw new FeatureFlagPinnedError(
        `${name} is pinned by ${featureFlagEnvironmentVariable(name)} and can't be changed at runtime`,
      );
    }
    const before = this.isEnabled(name);
    if (enabled === null) {
      await this.db.run("DELETE FROM settings WHERE key = ?", SETTING_PREFIX + name);
      this.overrides.delete(name);
    } else {
      await this.db.run(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        SETTING_PREFIX + name,
        JSON.stringify(enabled),
      );
      this.overrides.set(name, enabled);
    }
    const after = this.isEnabled(name);
    if (after !== before) for (const listener of this.listeners.get(name) ?? []) listener(after);
  }

  /** Calls `listener` whenever the flag's effective value changes. Returns an unsubscribe. */
  onChange(name: FeatureFlagName, listener: (enabled: boolean) => void): () => void {
    const set = this.listeners.get(name) ?? new Set();
    this.listeners.set(name, set);
    set.add(listener);
    return () => set.delete(listener);
  }
}
