import { attemptSync } from "./result";

// Browser storage can be unavailable (blocked, some private modes) or full.
// Nothing kept here is essential — a failure means the preference lasts this
// session only — so it is reported once per session, not on every call.
// diagnostics is loaded lazily: it imports auth, which imports this module.
let reported = false;
const report = (error: Error): void => {
  if (reported) return;
  reported = true;
  void import("./diagnostics").then(({ logClientEvent }) =>
    logClientEvent({
      level: "warn",
      event: "storage.unavailable",
      message: "Browser storage is unavailable; preferences last this session only",
      data: { error: error.message },
    }),
  );
};

export const readStorage = (key: string): string | null => {
  const read = attemptSync(() => window.localStorage.getItem(key));
  if (read.ok) return read.value;
  report(read.error);
  return null;
};

export const writeStorage = (key: string, value: string): void => {
  const written = attemptSync(() => window.localStorage.setItem(key, value));
  if (!written.ok) report(written.error);
};

export const removeStorage = (key: string): void => {
  const removed = attemptSync(() => window.localStorage.removeItem(key));
  if (!removed.ok) report(removed.error);
};
