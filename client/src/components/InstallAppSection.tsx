import { useState, useSyncExternalStore } from "react";
import { getInstallState, promptInstall, subscribeInstallState } from "../install";

type Props = {
  sectionClassName?: string;
  titleClassName?: string;
  hintClassName?: string;
};

/**
 * "Install Photrix on this device" — rendered inside the Account panel. Hidden
 * once running as the installed app, since there is nothing left to do.
 */
export const InstallAppSection = ({ sectionClassName, titleClassName, hintClassName }: Props) => {
  const state = useSyncExternalStore(subscribeInstallState, getInstallState, getInstallState);
  const [busy, setBusy] = useState(false);

  if (state === "installed") return null;

  const handleInstall = async () => {
    setBusy(true);
    try {
      await promptInstall();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={sectionClassName} aria-labelledby="install-app-title">
      <h3 id="install-app-title" className={titleClassName}>
        Install app
      </h3>
      <p className={hintClassName}>
        Open Photrix in its own window, with an icon on your home screen or desktop.
      </p>
      {state === "available" && (
        <div>
          <button
            className="btn btn-primary"
            onClick={() => void handleInstall()}
            disabled={busy}
          >
            Install Photrix
          </button>
        </div>
      )}
      {state === "ios" && (
        <p className={hintClassName}>
          In Safari, tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>. The
          installed app keeps its own sign-in, so you&apos;ll sign in once more there.
        </p>
      )}
      {state === "manual" && (
        <p className={hintClassName}>
          Use your browser&apos;s menu and choose <strong>Install app</strong> or{" "}
          <strong>Add to Home screen</strong>.
        </p>
      )}
    </section>
  );
};
