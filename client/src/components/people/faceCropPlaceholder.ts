// Straight from the module, not the ../api barrel, which many component specs
// replace wholesale with a mock.
import { faceCropRegion } from "../../api/people";
import { buildFileUrl } from "../../api/photoItem";
import type { ClusterFace } from "../../api/types";

// Feedback #154: a face crop is cut from the original photo on first view,
// a full HEIC/RAW decode (median ~0.5 s, several seconds for some, measured on
// the live library), and a People page asks for a hundred at once. The grid's
// 320px tile of the same photo is pre-generated for the whole library and
// serves in ~25 ms. Cutting the face out of that tile gives a soft preview
// right away; the real crop paints over it when it arrives.

// The grid tile size the thumbnail backfill pre-generates for every photo.
const TILE_HEIGHT = "320";
// Enough tiles for a page of faces from distinct photos; each is ~20 KB.
const MAX_TILES = 150;
const MAX_PLACEHOLDERS = 600;

const tiles = new Map<string, Promise<HTMLImageElement>>();
const placeholders = new Map<string, string>();

const remember = <V>(cache: Map<string, V>, key: string, value: V, max: number) => {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > max) cache.delete(cache.keys().next().value as string);
};

const loadTile = (path: string): Promise<HTMLImageElement> => {
  const cached = tiles.get(path);
  if (cached) return cached;
  const img = new Image();
  img.decoding = "async";
  img.src = buildFileUrl(path, { representation: "webSafe", height: TILE_HEIGHT });
  const loading = img.decode().then(() => img);
  // A failed tile must not stick: the next face from that photo retries.
  loading.catch(() => tiles.delete(path));
  remember(tiles, path, loading, MAX_TILES);
  return loading;
};

const placeholderKey = (face: ClusterFace) => {
  const { x, y, w, h } = faceCropRegion(face);
  return `${face.photo.path}|${x},${y},${w},${h}`;
};

/** A ready placeholder for this face, if one was already made. */
export const peekFaceCropPlaceholder = (face: ClusterFace): string | null =>
  placeholders.get(placeholderKey(face)) ?? null;

/**
 * The face's crop region cut from the photo's grid tile, as a small data URL
 * with the crop's own aspect ratio — so as an `<img>` background with
 * `cover`/`center` it lines up with the real crop under `object-fit: cover`.
 * Null for a face found in a video: its tile is a different frame.
 */
export const makeFaceCropPlaceholder = async (
  face: ClusterFace,
): Promise<string | null> => {
  if (face.frameTimeMs !== undefined) return null;
  const key = placeholderKey(face);
  const ready = placeholders.get(key);
  if (ready) return ready;

  const tile = await loadTile(face.photo.path);
  const { x, y, w, h } = faceCropRegion(face);
  const sx = x * tile.naturalWidth;
  const sy = y * tile.naturalHeight;
  const sw = Math.max(1, w * tile.naturalWidth);
  const sh = Math.max(1, h * tile.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(sw);
  canvas.height = Math.round(sh);
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(tile, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL("image/jpeg", 0.85);
  remember(placeholders, key, url, MAX_PLACEHOLDERS);
  return url;
};
