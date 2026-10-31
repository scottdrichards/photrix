/**
 * Formats a media duration for the tile overlay: `m:ss`, growing to `h:mm:ss`
 * past an hour. Returns null for anything that isn't a usable positive length,
 * so callers can simply skip rendering.
 */
export const formatDuration = (seconds: unknown): string | null => {
  const value =
    typeof seconds === "number"
      ? seconds
      : typeof seconds === "string"
        ? Number.parseFloat(seconds)
        : Number.NaN;

  if (!Number.isFinite(value) || value <= 0) return null;

  const total = Math.round(value);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");

  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
};
