import { runWithoutRequestAbortSignal } from "../common/requestAbort.ts";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { notablePlaceTextFor } from "../places/placeNames.ts";
import { dayNumber, defaultDetectOptions, detectStories } from "./detectStories.ts";
import {
  frameCount,
  highlightScore,
  pickHighlights,
  type HighlightCandidate,
} from "./pickHighlights.ts";
import { storyRoute } from "./storyRoute.ts";
import { parsePlace, storyTitle } from "./storyTitle.ts";
import type {
  StoryChapter,
  StoryDetail,
  StoryFace,
  StoryItem,
  StoryPerson,
  StorySpan,
  StorySummary,
} from "./storyTypes.ts";

type StoriesDatabase = Pick<IndexDatabase, "stories" | "getDefaultExclusionFilter">;

/**
 * Detection reads the whole timeline, so its result is kept: until newly
 * indexed photos change the timeline (but at most every MIN_REBUILD_MS while a
 * library is still being indexed), and never longer than CACHE_TTL_MS, which
 * picks up names given to faces.
 */
const CACHE_TTL_MS = 10 * 60_000;
const MIN_REBUILD_MS = 30_000;

const pad = (n: number) => String(n).padStart(2, "0");
const localTime = (time: number) => {
  const d = new Date(time);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

const peopleIn = (faces: StoryFace[]): StoryPerson[] => {
  const byName = new Map<string, { photos: Set<string>; face: StoryFace }>();
  for (const face of faces) {
    if (!face.name) continue;
    const entry = byName.get(face.name) ?? { photos: new Set(), face };
    entry.photos.add(face.path);
    // The largest face makes the sharpest avatar.
    if (face.width * face.height > entry.face.width * entry.face.height)
      entry.face = face;
    byName.set(face.name, entry);
  }
  return [...byName]
    .map(([name, { photos, face }]) => ({
      name,
      count: photos.size,
      face: {
        path: face.path,
        box: { x: face.x, y: face.y, width: face.width, height: face.height },
      },
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
};

type Built = { span: StorySpan; summary: StorySummary; faces: StoryFace[] };

/**
 * Stories: trips and big days found in the library, each told as a short
 * cinematic recap. Detection runs over every dated item and is cached for
 * CACHE_TTL_MS; a story's frames are picked on demand, with CLIP vectors
 * keeping near-duplicates out.
 */
export class StoriesService {
  private cache: { at: number; version: number; stories: Promise<Built[]> } | null = null;

  constructor(private readonly database: StoriesDatabase) {}

  private async build(): Promise<Built[]> {
    const version = await this.database.stories.getTimelineVersion();
    const age = this.cache ? Date.now() - this.cache.at : Infinity;
    if (
      this.cache &&
      age < CACHE_TTL_MS &&
      (this.cache.version === version || age < MIN_REBUILD_MS)
    )
      return this.cache.stories;
    // Shared by every caller until it expires, so one client hanging up must not abort it.
    const stories = runWithoutRequestAbortSignal(async () => {
      const rows = await this.database.stories.getTimeline(
        await this.database.getDefaultExclusionFilter(),
      );
      const items: StoryItem[] = rows.map((row) => ({ ...row, place: null }));
      const built: Built[] = [];
      for (const span of detectStories(items, defaultDetectOptions(items))) {
        // Named for the city a person would say they were in (see notablePlaceTextFor),
        // and only for story items: the lookup is per photo.
        for (const item of span.items) {
          if (item.lat !== null && item.lon !== null)
            item.place = notablePlaceTextFor(item.lat, item.lon);
        }
        // The time range also covers photos outside the story (excluded ones, say).
        const paths = new Set(span.items.map(({ path }) => path));
        const faces = (
          await this.database.stories.getFaces(
            span.items[0].time,
            span.items.at(-1)!.time,
          )
        ).filter(({ path }) => paths.has(path));
        built.push({ span, faces, summary: this.summarize(span, faces) });
      }
      return built;
    });
    this.cache = { at: Date.now(), version, stories };
    void stories.catch(() => {
      // A failed build must not be served for the next ten minutes.
      if (this.cache?.stories === stories) this.cache = null;
    });
    return stories;
  }

  private candidates(
    span: StorySpan,
    faces: StoryFace[],
    embeddings = new Map<string, Float32Array>(),
  ) {
    const facesByPath = new Map<string, StoryFace[]>();
    for (const face of faces)
      facesByPath.set(face.path, [...(facesByPath.get(face.path) ?? []), face]);
    return span.items
      .filter((item) => !item.isVideo && !item.burstMember)
      .map((item): HighlightCandidate => ({
        item,
        faces: facesByPath.get(item.path) ?? [],
        embedding: embeddings.get(item.path) ?? null,
      }));
  }

  private summarize(span: StorySpan, faces: StoryFace[]): StorySummary {
    const people = peopleIn(faces);
    const candidates = this.candidates(span, faces);
    const showable = candidates.length
      ? candidates
      : span.items.map((item) => ({ item, faces: [], embedding: null }));
    const cover = showable.reduce((best, next) =>
      highlightScore(next) > highlightScore(best) ? next : best,
    ).item;
    const collage = pickHighlights(
      showable.filter(({ item }) => item !== cover),
      3,
    ).map(({ item }) => item.path);
    return {
      id: span.id,
      kind: span.kind,
      ...storyTitle(span.kind, span.startDay, span.items, people),
      startDay: span.startDay,
      endDay: span.endDay,
      startTime: span.items[0].time,
      endTime: span.items.at(-1)!.time,
      dayCount: span.dayCount,
      photoCount: span.items.filter(({ isVideo }) => !isVideo).length,
      videoCount: span.items.filter(({ isVideo }) => isVideo).length,
      distanceKm: storyRoute(span.items).distanceKm,
      cover: { path: cover.path, width: cover.width, height: cover.height },
      collage,
      people,
    };
  }

  async list(): Promise<StorySummary[]> {
    return (await this.build()).map(({ summary }) => summary);
  }

  async detail(id: string): Promise<StoryDetail | null> {
    const story = (await this.build()).find(({ span }) => span.id === id);
    if (!story) return null;
    const { span, faces, summary } = story;
    const all = this.candidates(span, faces);
    const embeddings = await this.database.stories.getImageEmbeddings(
      all.map(({ item }) => item.path),
    );
    const picks = pickHighlights(
      this.candidates(span, faces, embeddings),
      frameCount(all.length),
    );
    const firstDay = dayNumber(span.items[0].time);
    const frames = picks.map(({ item, faces: frameFaces }) => ({
      path: item.path,
      localTime: localTime(item.time),
      day: dayNumber(item.time) - firstDay + 1,
      width: item.width,
      height: item.height,
      lat: item.lat,
      lon: item.lon,
      place: parsePlace(item.place)?.city ?? null,
      faces: frameFaces.map(({ x, y, width, height, name }) => ({
        x,
        y,
        width,
        height,
        name,
      })),
    }));
    return {
      ...summary,
      frames,
      chapters: chaptersOf(frames, span.items),
      route: storyRoute(span.items).route,
    };
  }
}

/** A chapter per story day that has frames, placed at that day's most-photographed city. */
const chaptersOf = (
  frames: StoryDetail["frames"],
  items: StoryItem[],
): StoryChapter[] => {
  const firstDay = dayNumber(items[0].time);
  const chapters: StoryChapter[] = [];
  frames.forEach((frame, index) => {
    if (chapters.at(-1)?.day === frame.day) return;
    const cities = items
      .filter(({ time }) => dayNumber(time) - firstDay + 1 === frame.day)
      .flatMap(({ place }) => parsePlace(place)?.city ?? []);
    const counts = new Map<string, number>();
    for (const city of cities) counts.set(city, (counts.get(city) ?? 0) + 1);
    const place = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    chapters.push({
      day: frame.day,
      date: frame.localTime.slice(0, 10),
      place,
      firstFrame: index,
    });
  });
  return chapters;
};
