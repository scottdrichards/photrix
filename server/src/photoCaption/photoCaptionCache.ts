import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname } from "path";
import { getMirroredCachedFilePath } from "../common/cacheUtils.ts";

type CachedCaption = {
  caption: string;
  generatedAt: number;
};

// One tiny JSON file per source photo, mirrored alongside its other cached
// derivatives (thumbnails, HLS, etc). Keyed by path only (not mtime, like the
// rest of the mirrored cache) — if the file's bytes ever change in place,
// clearMirroredCacheForFile (called by the existing re-index path) deletes
// this alongside everything else, so a stale caption doesn't outlive an edit.
const cachePathFor = (absoluteFilePath: string): string =>
  getMirroredCachedFilePath(absoluteFilePath, "caption", "json");

export const getCachedPhotoCaption = async (
  absoluteFilePath: string,
): Promise<string | null> => {
  try {
    const raw = await readFile(cachePathFor(absoluteFilePath), "utf-8");
    const parsed = JSON.parse(raw) as Partial<CachedCaption>;
    return typeof parsed.caption === "string" ? parsed.caption : null;
  } catch {
    return null;
  }
};

export const setCachedPhotoCaption = async (
  absoluteFilePath: string,
  caption: string,
): Promise<void> => {
  const cachePath = cachePathFor(absoluteFilePath);
  const entry: CachedCaption = { caption, generatedAt: Date.now() };
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(entry));
};
