import { attempt } from "./result";
import { logFailure } from "./logFailure";

export const copyToClipboard = async (text: string): Promise<boolean> => {
  // The async clipboard needs a secure context and permission; when it says no,
  // the legacy path below still works on HTTP and localhost.
  if (navigator.clipboard?.writeText) {
    const copied = await attempt(navigator.clipboard.writeText(text));
    if (copied.ok) return true;
    logFailure("clipboard.write.failed", "Async clipboard refused; using the legacy copy")(copied.error);
  }
  // Legacy execCommand — works on HTTP / localhost
  const el = document.createElement("textarea");
  el.value = text;
  el.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0";
  document.body.appendChild(el);
  el.focus();
  el.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(el);
  return ok;
};
