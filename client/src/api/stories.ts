import { fetchJsonOrThrow, fetchWithDiagnostics } from "./http";
import { buildFileUrl } from "./photoItem";

/** Mirrors server/src/stories/storyTypes.ts. */
export type StoryKind = "trip" | "weekend" | "dayTrip" | "event";

export type StoryBox = { x: number; y: number; width: number; height: number };

export type StoryPerson = {
  name: string;
  count: number;
  face: { path: string; box: StoryBox } | null;
};

export type StorySummary = {
  id: string;
  kind: StoryKind;
  kicker: string;
  title: string;
  startDay: string;
  endDay: string;
  startTime: number;
  endTime: number;
  dayCount: number;
  photoCount: number;
  videoCount: number;
  places: string[];
  distanceKm: number | null;
  cover: { path: string; width: number | null; height: number | null };
  collage: string[];
  people: StoryPerson[];
};

export type StoryFrame = {
  path: string;
  localTime: string;
  day: number;
  width: number | null;
  height: number | null;
  lat: number | null;
  lon: number | null;
  place: string | null;
  faces: Array<StoryBox & { name: string | null }>;
};

export type StoryChapter = {
  day: number;
  date: string;
  place: string | null;
  firstFrame: number;
};

export type StoryDetail = StorySummary & {
  frames: StoryFrame[];
  chapters: StoryChapter[];
  route: Array<{ lat: number; lon: number }>;
};

/** Stories cover the whole library, so a share link is refused them. */
export class StoriesForbiddenError extends Error {}

export const fetchStories = async (signal?: AbortSignal): Promise<StorySummary[]> => {
  const response = await fetchWithDiagnostics("/api/stories", "load stories", { signal });
  if (response.status === 403)
    throw new StoriesForbiddenError("Stories are not part of a shared link");
  if (!response.ok) throw new Error(`Failed to load stories (status ${response.status})`);
  return ((await response.json()) as { stories: StorySummary[] }).stories;
};

export const fetchStory = (id: string, signal?: AbortSignal): Promise<StoryDetail> =>
  fetchJsonOrThrow<StoryDetail>(`/api/stories/${encodeURIComponent(id)}`, "load story", {
    signal,
  });

/** A story image at a standard height (see server/src/common/standardHeights.ts). */
export const storyImageUrl = (path: string, height: 320 | 640 | 1080 | 2160) =>
  buildFileUrl(path, { representation: "webSafe", height: String(height) });
