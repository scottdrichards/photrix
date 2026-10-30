/**
 * Chrome caps one Web Share call at 10 files and 50 MB (per file on Android,
 * in total on desktop). Over either, `navigator.share()` rejects with
 * NotAllowedError, and `navigator.canShare()` doesn't check, so the only signal
 * is the failed share itself. Safari has no such cap, which is why the app
 * still tries the whole set first and only splits after a failure.
 */
export const WEB_SHARE_MAX_FILES = 10;
export const WEB_SHARE_MAX_BYTES = 50 * 1024 * 1024;

export type ShareParts = {
  /** Groups that each fit within the limits, in the original order. */
  parts: File[][];
  /** Files over the byte limit on their own: they can't be shared as files. */
  tooLarge: File[];
};

/**
 * Split files into groups that each fit one share. Bytes are counted per group,
 * the stricter desktop rule, so a group also satisfies Android's per-file cap.
 */
export const planShareParts = (
  files: File[],
  maxFiles: number = WEB_SHARE_MAX_FILES,
  maxBytes: number = WEB_SHARE_MAX_BYTES,
): ShareParts => {
  const parts: File[][] = [];
  const tooLarge: File[] = [];
  let current: File[] = [];
  let currentBytes = 0;
  for (const file of files) {
    if (file.size > maxBytes) {
      tooLarge.push(file);
      continue;
    }
    if (current.length === maxFiles || currentBytes + file.size > maxBytes) {
      parts.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(file);
    currentBytes += file.size;
  }
  if (current.length > 0) parts.push(current);
  return { parts, tooLarge };
};
