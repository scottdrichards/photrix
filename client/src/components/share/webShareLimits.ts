/**
 * Chrome refuses one Web Share of more than 10 files or 50 MB (per file on
 * Android, in total on desktop) with NotAllowedError, and `canShare()` checks
 * neither. So the app checks before sharing, and a selection over the limit is
 * offered as a link or a download instead of failing after every file loads.
 */
export const WEB_SHARE_MAX_FILES = 10;
export const WEB_SHARE_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Whether files of these sizes fit one share. An unknown size counts as zero,
 * so this answers "known to be over" before anything is fetched, and the real
 * answer once the files are in hand. Bytes are totalled, the stricter desktop
 * rule, which also satisfies Android's per-file cap.
 */
export const fitsOneShare = (sizes: ReadonlyArray<number | undefined>): boolean => {
  if (sizes.length > WEB_SHARE_MAX_FILES) return false;
  const total = sizes.reduce<number>((sum, size) => sum + (size ?? 0), 0);
  return total <= WEB_SHARE_MAX_BYTES;
};
