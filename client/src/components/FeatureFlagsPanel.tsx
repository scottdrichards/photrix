import { useState } from "react";
import {
  featureFlagEnvironmentVariable,
  featureFlags,
  type FeatureFlagName,
  type FeatureFlagState,
} from "../../../shared/feature-flags/src/featureFlags";
import { useFeatureFlags } from "../featureFlags/FeatureFlagsContext";
import { attempt } from "../result";
import css from "./StatusModal.module.css";

const describeSource = (flag: FeatureFlagState): string => {
  if (flag.source === "environment") {
    return `Pinned on the server by ${featureFlagEnvironmentVariable(flag.name)}`;
  }
  const byDefault = featureFlags[flag.name].default ? "on" : "off";
  return flag.source === "override" ? `Changed here (default: ${byDefault})` : `Default (${byDefault})`;
};

/** Every feature flag with a switch; a flag pinned by the server's environment is shown locked. */
export const FeatureFlagsPanel = () => {
  const { flags, setOverride } = useFeatureFlags();
  const [busy, setBusy] = useState<FeatureFlagName | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!flags) return <progress />;

  const apply = async (name: FeatureFlagName, enabled: boolean | null) => {
    setBusy(name);
    setError(null);
    const applied = await attempt(setOverride(name, enabled));
    setBusy(null);
    if (!applied.ok) setError(`Couldn't change ${name}: ${applied.error.message}`);
  };

  return (
    <div className={css.container}>
      {flags.map((flag) => (
        <div className={css.toggleRow} key={flag.name}>
          <label className="switch-label">
            <input
              type="checkbox"
              role="switch"
              className="switch-track"
              aria-label={flag.name}
              checked={flag.enabled}
              disabled={flag.source === "environment" || busy === flag.name}
              onChange={(e) => void apply(flag.name, e.target.checked)}
            />
            <span>{flag.name}</span>
          </label>
          <small>{flag.description}</small>
          <small>{describeSource(flag)}</small>
          {flag.source === "override" && (
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy === flag.name}
              onClick={() => void apply(flag.name, null)}
            >
              Reset to default
            </button>
          )}
        </div>
      ))}
      {error && (
        <span className={css.errorText} role="alert">
          {error}
        </span>
      )}
    </div>
  );
};
