import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  featureFlags,
  type FeatureFlagName,
  type FeatureFlagState,
} from "../../../shared/feature-flags/src/featureFlags";
import { fetchFeatureFlags, setFeatureFlagOverride } from "../api";
import { logClientEvent } from "../diagnostics";

type FeatureFlagsContextValue = {
  /** Null until the server's answer arrives; flags read their defaults meanwhile. */
  flags: FeatureFlagState[] | null;
  setOverride: (name: FeatureFlagName, enabled: boolean | null) => Promise<void>;
};

const FeatureFlagsContext = createContext<FeatureFlagsContextValue | null>(null);

export const FeatureFlagsProvider = ({ children }: { children: ReactNode }) => {
  const [flags, setFlags] = useState<FeatureFlagState[] | null>(null);

  useEffect(() => {
    fetchFeatureFlags().then(setFlags, (error: unknown) => {
      // The app runs on each flag's default until it can ask again (next load).
      logClientEvent({
        level: "error",
        event: "featureFlags.load.failed",
        message: "Could not load feature flags; using defaults",
        data: { error: error instanceof Error ? error.message : String(error) },
        immediate: true,
      });
    });
  }, []);

  const setOverride = useCallback(async (name: FeatureFlagName, enabled: boolean | null) => {
    setFlags(await setFeatureFlagOverride(name, enabled));
  }, []);

  const value = useMemo(() => ({ flags, setOverride }), [flags, setOverride]);
  return <FeatureFlagsContext.Provider value={value}>{children}</FeatureFlagsContext.Provider>;
};

export const useFeatureFlags = (): FeatureFlagsContextValue => {
  const context = useContext(FeatureFlagsContext);
  if (!context) throw new Error("useFeatureFlags must be used inside <FeatureFlagsProvider>");
  return context;
};

export const useFeatureFlag = (name: FeatureFlagName): boolean => {
  const { flags } = useFeatureFlags();
  return flags?.find((flag) => flag.name === name)?.enabled ?? featureFlags[name].default;
};
