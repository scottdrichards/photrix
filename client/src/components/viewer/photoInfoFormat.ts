// Formatting for the viewer's file-info panel: each returns null when the value is missing or unusable.

export const formatShutterSpeed = (exposureTime: unknown): string | null => {
  const t =
    typeof exposureTime === "number" ? exposureTime : parseFloat(String(exposureTime));
  if (!isFinite(t) || t <= 0) return null;
  if (t >= 1) return `${t}s`;
  const denom = Math.round(1 / t);
  return `1/${denom}s`;
};

export const formatAperture = (aperture: unknown): string | null => {
  const f = typeof aperture === "number" ? aperture : parseFloat(String(aperture));
  if (!isFinite(f) || f <= 0) return null;
  return `f/${f % 1 === 0 ? f.toFixed(0) : f.toFixed(1)}`;
};

export const formatFocalLength = (focalLength: unknown): string | null => {
  if (typeof focalLength !== "string" && typeof focalLength !== "number") return null;
  const str = String(focalLength).trim();
  // Handle rational notation "50/1"
  const rationalMatch = str.match(/^(\d+)\/(\d+)$/);
  if (rationalMatch) {
    const val = parseInt(rationalMatch[1]) / parseInt(rationalMatch[2]);
    return `${Math.round(val)}mm`;
  }
  const num = parseFloat(str);
  if (!isFinite(num)) return str;
  return str.includes("mm")
    ? str
    : `${num % 1 === 0 ? num.toFixed(0) : num.toFixed(1)}mm`;
};

export const formatFileSize = (bytes: unknown): string | null => {
  const b = typeof bytes === "number" ? bytes : parseInt(String(bytes));
  if (!isFinite(b) || b < 0) return null;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

export const formatDuration = (seconds: unknown): string | null => {
  const s = typeof seconds === "number" ? seconds : parseFloat(String(seconds));
  if (!isFinite(s) || s < 0) return null;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
};
