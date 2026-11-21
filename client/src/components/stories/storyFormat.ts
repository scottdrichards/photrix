import type { StorySummary } from "../../api/stories";

/** A "YYYY-MM-DD" calendar day at local noon, so no zone shift can move it. */
const atNoon = (day: string) => new Date(`${day}T12:00:00`);

/** "May 3 – 6, 2023", "May 30 – Jun 2, 2023", "Dec 30, 2023 – Jan 2, 2024", or one day. */
export const formatDayRange = (startDay: string, endDay: string) => {
  const start = atNoon(startDay);
  const end = atNoon(endDay);
  const format = (date: Date, options: Intl.DateTimeFormatOptions) =>
    date.toLocaleDateString("en-US", options);
  if (startDay === endDay)
    return format(start, { month: "long", day: "numeric", year: "numeric" });
  if (start.getFullYear() !== end.getFullYear()) {
    return `${format(start, { month: "short", day: "numeric", year: "numeric" })} – ${format(end, { month: "short", day: "numeric", year: "numeric" })}`;
  }
  const endPart =
    start.getMonth() === end.getMonth()
      ? format(end, { day: "numeric" })
      : format(end, { month: "short", day: "numeric" });
  return `${format(start, { month: start.getMonth() === end.getMonth() ? "long" : "short", day: "numeric" })} – ${endPart}, ${end.getFullYear()}`;
};

/** "Thu, May 4 · 5:10 PM" for a zone-less wall-clock time. */
export const formatFrameTime = (localTime: string) => {
  const date = new Date(localTime);
  return `${date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} · ${date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
};

/** Miles where the road signs are in miles. */
export const usesMiles = (language: string) => /-(US|GB|LR|MM)$/i.test(language);

export const formatDistance = (km: number, language: string) =>
  usesMiles(language)
    ? `${Math.round(km * 0.621371).toLocaleString("en-US")} mi`
    : `${Math.round(km).toLocaleString("en-US")} km`;

const plural = (count: number, noun: string) =>
  `${count.toLocaleString("en-US")} ${noun}${count === 1 ? "" : "s"}`;

/** "4 days · 12 photos · 1 video · 290 mi"; distance only once it's more than a walk. */
export const formatStoryStats = (
  story: Pick<StorySummary, "dayCount" | "photoCount" | "videoCount" | "distanceKm">,
  language: string,
) =>
  [
    story.dayCount > 1 ? plural(story.dayCount, "day") : null,
    plural(story.photoCount, "photo"),
    story.videoCount ? plural(story.videoCount, "video") : null,
    story.distanceKm !== null && story.distanceKm >= 10
      ? formatDistance(story.distanceKm, language)
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
