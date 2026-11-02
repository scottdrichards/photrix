import { useEffect, useState } from "react";
import { watchForAppUpdate } from "../appUpdate";
import css from "./AppUpdateNotice.module.css";

/**
 * Offers a reload when a new version is deployed while the app is open
 * (feedback #172). Coming back to the app reloads on its own; this only
 * shows when the update lands while someone is using it.
 */
export const AppUpdateNotice = () => {
  const [available, setAvailable] = useState(false);

  useEffect(() => watchForAppUpdate({ onUpdateAvailable: () => setAvailable(true) }), []);

  if (!available) return null;

  return (
    <div className={css.notice} role="status">
      <span>A new version of Photrix is ready.</span>
      <button type="button" className={css.reload} onClick={() => window.location.reload()}>
        Reload
      </button>
      <button
        type="button"
        className={css.dismiss}
        aria-label="Not now"
        onClick={() => setAvailable(false)}
      >
        ×
      </button>
    </div>
  );
};
