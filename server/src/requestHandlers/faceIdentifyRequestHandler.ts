import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import type * as http from "node:http";
import { isIP } from "node:net";
import path from "node:path";
import sharp from "sharp";
import { CACHE_DIR } from "../common/cacheUtils.js";
import {
  DEFAULT_IDENTIFY_THRESHOLD,
  DEFAULT_MIN_FACE_CONFIDENCE,
  DEFAULT_MIN_FACE_PIXELS,
  DEFAULT_MIN_MARGIN,
  DEFAULT_STRONG_THRESHOLD,
  identifyFaces,
  prepareCentroids,
  type IdentifiedFace,
  type PreparedCentroid,
} from "../faceDetection/identifyFaces.ts";
import type { analyzeImage as AnalyzeImageFn } from "../imageAnalysis/imageAnalysisWorker.ts";
import { isWorkerEvictedError } from "../taskOrchestrator/computeWorkers.ts";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { getLogger } from "../observability/logger.ts";
import { writeJson } from "../utils.ts";

const log = getLogger("faceIdentify");

const TEMP_DIR = path.join(CACHE_DIR, "face-identify");

/** Largest single image accepted. A 5 MP camera JPEG is ~2 MB; 16 is generous. */
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

/**
 * Frames accepted in one request.
 *
 * Multi-frame is the whole point of the endpoint's shape. A camera's person
 * detection fires on a back, an umbrella, a head turned to the door lock — any
 * single frame of a real visit is more likely than not to have no usable face
 * in it, while the visit as a whole almost always has one. Sampling a handful
 * of moments across the event and keeping the best answer turns a coin flip
 * into a reliable one. The cap keeps a caller from turning one doorbell visit
 * into a minute of detector time.
 */
const MAX_FRAMES = 6;

/** How long a fetched frame URL may take before we give up on it. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * How long the named-centroid snapshot is reused before it is re-read.
 *
 * Naming a person in the People tab is a rare, human-paced event, while this
 * endpoint can be hit several times per doorbell visit — so a short TTL cache
 * keeps a burst from re-reading and re-normalizing every centroid, and the
 * worst case is that a person named seconds ago goes unrecognized for one
 * minute. Renames drop the cache outright (see peopleRequestHandler).
 */
const CENTROID_CACHE_TTL_MS = 60_000;

/**
 * Identification requests accepted at once; the rest are shed with a 429.
 *
 * The Python analysis worker is a single process shared with background
 * ingestion and interactive search, and it serializes its own requests — so
 * this is not a concurrency limit, it is a queue-depth limit. Letting a
 * camera's event burst pile ten near-duplicate requests onto that worker would
 * stall search behind them for no gain, and by the time the tenth ran its
 * answer would be stale. The caller is expected to debounce; this is the
 * backstop for when it doesn't.
 */
const MAX_ACTIVE = 3;

let active = 0;

type CentroidCache = { at: number; centroids: PreparedCentroid[] };
let centroidCache: CentroidCache | null = null;
let centroidLoad: Promise<PreparedCentroid[]> | null = null;

/** Drops the cache after a rename/merge so a new name takes effect immediately. */
export const invalidateNamedCentroidCache = (): void => {
  centroidCache = null;
};

const getCentroids = async (database: IndexDatabase): Promise<PreparedCentroid[]> => {
  const now = Date.now();
  if (centroidCache && now - centroidCache.at < CENTROID_CACHE_TTL_MS) {
    return centroidCache.centroids;
  }
  // Memoized so a burst arriving on a cold cache reads the table once.
  if (!centroidLoad) {
    centroidLoad = database
      .getNamedFaceCentroids()
      .then((rows) => {
        const centroids = prepareCentroids(rows);
        centroidCache = { at: Date.now(), centroids };
        return centroids;
      })
      .finally(() => {
        centroidLoad = null;
      });
  }
  return centroidLoad;
};

class BadRequest extends Error {}

const readBodyBytes = (req: http.IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_IMAGE_BYTES) {
        reject(new BadRequest(`Body exceeds ${MAX_IMAGE_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

/**
 * True for addresses on this LAN / loopback.
 *
 * Frame URLs exist so Home Assistant can hand over a Frigate URL instead of
 * proxying JPEG bytes through its own templating layer, which it is bad at.
 * That convenience turns the server into a fetcher, so the host is pinned to
 * private space: an authenticated caller still shouldn't be able to aim the
 * photo server at arbitrary internet endpoints, and every real caller is on the
 * LAN anyway.
 */
const isPrivateHost = (hostname: string): boolean => {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost") return true;
  const version = isIP(host);
  if (version === 0) return false;
  if (version === 6) return host === "::1" || /^f[cd]/i.test(host);
  const [a, b] = host.split(".").map(Number);
  if (a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
};

const fetchFrame = async (rawUrl: string): Promise<Buffer> => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BadRequest(`Not a valid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BadRequest("Frame URLs must be http or https");
  }
  if (!isPrivateHost(url.hostname)) {
    throw new BadRequest("Frame URLs must point at a private/LAN address");
  }

  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new BadRequest(`Frame fetch returned HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) throw new BadRequest("Frame fetch returned an empty body");
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new BadRequest(`Frame exceeds ${MAX_IMAGE_BYTES} bytes`);
  }
  return buffer;
};

const numberParam = (params: URLSearchParams, key: string, fallback: number): number => {
  const raw = params.get(key);
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
};

/** Lazily-resolved frames: raw bytes are already here, URLs are fetched on demand. */
type FrameSource = {
  label: string;
  load: () => Promise<Buffer>;
  /** Normalized [x, y, w, h] to crop to before detection, if the caller gave one. */
  box?: readonly number[];
  pad?: number;
};

const isNormalizedBox = (value: unknown): value is number[] =>
  Array.isArray(value) &&
  value.length === 4 &&
  value.every((n) => typeof n === "number" && Number.isFinite(n));

/**
 * One entry of `imageUrls`: either a bare URL string, or an object carrying the
 * URL plus the crop box for that moment. Per-frame boxes matter because a
 * walking subject is in a different place in every frame sampled.
 */
const parseFrameEntry = (entry: unknown): FrameSource => {
  if (typeof entry === "string") {
    return { label: entry, load: () => fetchFrame(entry) };
  }
  if (typeof entry !== "object" || entry === null) {
    throw new BadRequest("Each imageUrls entry must be a URL string or an object");
  }
  const object = entry as Record<string, unknown>;
  if (typeof object.url !== "string") {
    throw new BadRequest("Each imageUrls object needs a url");
  }
  const url = object.url;
  if (object.box !== undefined && !isNormalizedBox(object.box)) {
    throw new BadRequest("box must be four numbers: [x, y, width, height], normalized");
  }
  return {
    label: url,
    load: () => fetchFrame(url),
    ...(object.box ? { box: object.box } : {}),
    ...(typeof object.pad === "number" ? { pad: object.pad } : {}),
  };
};

/**
 * Resolves the frames to classify from any accepted request shape: raw bytes
 * with an `image/*` content type, or JSON carrying `imageUrl`, `imageUrls`, or
 * `imageBase64`.
 *
 * URLs stay unfetched until their frame is actually needed, so an early
 * confident match costs one HTTP GET rather than six.
 */
const resolveFrames = async (req: http.IncomingMessage): Promise<FrameSource[]> => {
  const contentType = (req.headers["content-type"] ?? "").toString();
  const body = await readBodyBytes(req);
  if (body.length === 0) throw new BadRequest("Empty request body");

  if (contentType.startsWith("image/") || contentType === "application/octet-stream") {
    return [{ label: "body", load: () => Promise.resolve(body) }];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf-8"));
  } catch {
    throw new BadRequest(
      "Body must be image bytes (Content-Type: image/*) or JSON with imageUrl/imageUrls/imageBase64",
    );
  }
  const object = parsed as Record<string, unknown>;

  if (Array.isArray(object.imageUrls)) {
    if (object.imageUrls.length === 0) throw new BadRequest("imageUrls was empty");
    if (object.imageUrls.length > MAX_FRAMES) {
      throw new BadRequest(`imageUrls accepts at most ${MAX_FRAMES} frames`);
    }
    return object.imageUrls.map(parseFrameEntry);
  }
  if (typeof object.imageUrl === "string") {
    const url = object.imageUrl;
    const box = isNormalizedBox(object.box) ? object.box : undefined;
    return [
      {
        label: url,
        load: () => fetchFrame(url),
        ...(box ? { box } : {}),
        ...(typeof object.pad === "number" ? { pad: object.pad } : {}),
      },
    ];
  }
  if (typeof object.imageBase64 === "string") {
    const bytes = Buffer.from(
      object.imageBase64.replace(/^data:[^;]+;base64,/, ""),
      "base64",
    );
    if (bytes.length === 0) throw new BadRequest("imageBase64 decoded to nothing");
    return [{ label: "imageBase64", load: () => Promise.resolve(bytes) }];
  }
  throw new BadRequest("JSON body must contain imageUrl, imageUrls or imageBase64");
};

/**
 * Default padding added around a supplied crop box, as a fraction of the box.
 *
 * A caller's box bounds the *subject* (a person), and it is usually the box
 * from one moment of a moving subject. Padding covers the drift and, more
 * importantly, gives the detector context around the head — a box cut tight to
 * a torso can clip the very face we are looking for.
 */
const DEFAULT_CROP_PAD = 0.3;

/**
 * Crops to a normalized [x, y, width, height] box, padded.
 *
 * This exists because of how InsightFace sizes its input: the detector runs at
 * 640x640, so handing it a 2560x1920 frame downscales a distant face to a
 * dozen pixels and finds nothing at all — measured on this doorbell, the
 * full-resolution frame yielded zero detections while the same frame cropped to
 * the person yielded a 180x290px face. Cropping is what converts "more
 * megapixels" into "more face pixels".
 *
 * Face boxes in the response are normalized against the *cropped* image, not
 * the original frame; the crop rect is reported per frame so a caller that
 * needs original-frame coordinates can map back.
 */
const cropToBox = async (
  bytes: Buffer,
  box: readonly number[],
  pad: number,
): Promise<{
  bytes: Buffer;
  rect: { left: number; top: number; width: number; height: number };
}> => {
  const [bx, by, bw, bh] = box;
  const { width, height } = await sharp(bytes).metadata();
  if (!width || !height) throw new BadRequest("Could not read frame dimensions to crop");

  const left = Math.max(0, Math.round((bx - bw * pad) * width));
  const top = Math.max(0, Math.round((by - bh * pad) * height));
  const right = Math.min(width, Math.round((bx + bw * (1 + pad)) * width));
  const bottom = Math.min(height, Math.round((by + bh * (1 + pad)) * height));
  const rect = { left, top, width: right - left, height: bottom - top };
  if (rect.width < 1 || rect.height < 1) {
    throw new BadRequest(`Crop box ${JSON.stringify(box)} is empty for this frame`);
  }
  // Rotation is baked in first: an EXIF-rotated frame would otherwise have its
  // crop applied to the unrotated pixels.
  return { bytes: await sharp(bytes).rotate().extract(rect).toBuffer(), rect };
};

/**
 * Long edge the Python worker caps its decode at (`MAX_DECODE_EDGE` there).
 * Face boxes come back normalized, so turning one into a pixel size means
 * knowing the size the worker actually decoded at, not the size on disk.
 */
const WORKER_MAX_DECODE_EDGE = 2048;

/** Size the worker will have decoded this image at, for the face-size gate. */
const decodedSizeOf = async (
  bytes: Buffer,
): Promise<{ width: number; height: number } | undefined> => {
  try {
    const { width, height } = await sharp(bytes).metadata();
    if (!width || !height) return undefined;
    const scale = Math.min(1, WORKER_MAX_DECODE_EDGE / Math.max(width, height));
    return { width: Math.round(width * scale), height: Math.round(height * scale) };
  } catch {
    // Unreadable header is not fatal: the detector may still cope, and the
    // caller gets a face with no size gate rather than no answer at all.
    return undefined;
  }
};

/**
 * Pause before retrying a frame whose worker was evicted mid-pass.
 *
 * Long enough for the killed worker to be respawned by the next `ensureReady`,
 * short enough to stay inside the caller's timeout. If a video is still
 * playing the GPU reclaim is still in force and the retry will be killed too —
 * that is reported honestly rather than retried into the ground.
 */
const EVICTION_RETRY_DELAY_MS = 2_000;

/** Writes one frame to a scratch file, runs the detector, then cleans up. */
const analyzeFrame = async (
  bytes: Buffer,
  analyzeImage: typeof AnalyzeImageFn,
): Promise<{
  faces: NonNullable<Awaited<ReturnType<typeof AnalyzeImageFn>>["faces"]>;
}> => {
  await mkdir(TEMP_DIR, { recursive: true });
  // The worker takes a path, not a buffer: it shares one decode between the
  // face and CLIP passes and is fed from disk everywhere else.
  const tempPath = path.join(TEMP_DIR, `${randomUUID()}.img`);
  await writeFile(tempPath, bytes);
  try {
    // The shared ML workers are SIGKILLed whenever a user starts a video
    // transcode, which reclaims their VRAM (see reclaimGpuForUser). That has
    // nothing to do with this frame, so — like the background analysis pass,
    // which defers and retries on the next sweep — treat it as transient and
    // give it exactly one more go rather than reporting "no face" for an image
    // the detector never actually looked at.
    for (let attempt = 0; ; attempt += 1) {
      try {
        const analysis = await analyzeImage(tempPath, {
          faces: true,
          embed: false,
          foreground: true,
        });
        if (analysis.facesError) throw new Error(analysis.facesError);
        return { faces: analysis.faces ?? [] };
      } catch (error) {
        if (attempt > 0 || !isWorkerEvictedError(error)) throw error;
        log.info("Analysis worker was evicted for a user GPU request; retrying frame");
        await new Promise((resolve) => setTimeout(resolve, EVICTION_RETRY_DELAY_MS));
      }
    }
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
};

type Match = {
  name: string;
  similarity: number;
  /** How far this beat the runner-up — the number worth tuning against. */
  margin: number;
  /** Index into the submitted frames — which moment actually saw this person. */
  frame: number;
};

export type FaceIdentifyDeps = {
  database: IndexDatabase;
  analyzeImage: typeof AnalyzeImageFn;
};

/**
 * `POST /api/faces/identify` — who is in these pictures?
 *
 * Runs the same InsightFace detector the library ingestion uses over
 * caller-supplied frames, then scores each detected face against the centroids
 * of the people who have been *named* in the People tab. Nothing is written:
 * the frames are scored and thrown away, never indexed, and the faces never
 * join a cluster.
 *
 * Frames are walked in order and the walk stops early on a confident,
 * unambiguous match, so the common case (the visitor's face is in the first
 * frame sampled) costs one detector pass while the awkward case still gets
 * every frame it needs.
 *
 * A frame with no face in it is the expected case, not an error. Those answer
 * `{"faceCount": 0, "people": []}` with HTTP 200 so a caller can treat "nobody
 * recognizable" as ordinary flow control rather than a failure to handle.
 */
export const faceIdentifyRequestHandler = async (
  req: http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
  res: http.ServerResponse,
  { database, analyzeImage }: FaceIdentifyDeps,
): Promise<void> => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/api/faces/people" && req.method === "GET") {
    const centroids = await getCentroids(database);
    const names = [...new Set(centroids.map((c) => c.name))].sort();
    writeJson(res, 200, { people: names, centroids: centroids.length });
    return;
  }

  if (url.pathname !== "/api/faces/identify" || req.method !== "POST") {
    writeJson(res, 404, { error: "Not found" });
    return;
  }

  if (active >= MAX_ACTIVE) {
    res.setHeader("Retry-After", "2");
    writeJson(res, 429, {
      error: "Face identification is busy",
      faceCount: 0,
      people: [],
    });
    return;
  }

  const startedAt = Date.now();
  active += 1;
  try {
    const frames = await resolveFrames(req);
    const centroids = await getCentroids(database);
    const options = {
      threshold: numberParam(url.searchParams, "threshold", DEFAULT_IDENTIFY_THRESHOLD),
      minMargin: numberParam(url.searchParams, "minMargin", DEFAULT_MIN_MARGIN),
      strongThreshold: numberParam(
        url.searchParams,
        "strongThreshold",
        DEFAULT_STRONG_THRESHOLD,
      ),
      minFaceConfidence: numberParam(
        url.searchParams,
        "minFaceConfidence",
        DEFAULT_MIN_FACE_CONFIDENCE,
      ),
      minFacePixels: numberParam(
        url.searchParams,
        "minFacePixels",
        DEFAULT_MIN_FACE_PIXELS,
      ),
    };

    const bestByName = new Map<string, Match>();
    const frameReports: Array<{
      frame: number;
      faces: number;
      crop?: { left: number; top: number; width: number; height: number };
      error?: string;
    }> = [];
    // Faces of the frame that saw the most of them — the one worth rendering a
    // box overlay from, and the best single estimate of how many people were
    // actually there.
    let bestFrameFaces: IdentifiedFace[] = [];
    let framesAnalyzed = 0;

    for (const [index, frame] of frames.entries()) {
      let faces: IdentifiedFace[];
      let crop: { left: number; top: number; width: number; height: number } | undefined;
      try {
        let bytes = await frame.load();
        if (frame.box) {
          const cropped = await cropToBox(
            bytes,
            frame.box,
            frame.pad ?? DEFAULT_CROP_PAD,
          );
          bytes = cropped.bytes;
          crop = cropped.rect;
        }
        const [analysis, decodedSize] = await Promise.all([
          analyzeFrame(bytes, analyzeImage),
          decodedSizeOf(bytes),
        ]);
        faces = identifyFaces(analysis.faces, centroids, { ...options, decodedSize });
      } catch (error) {
        if (error instanceof BadRequest && framesAnalyzed === 0 && frames.length === 1) {
          throw error;
        }
        // One unreadable frame out of several is not a failed request — a
        // recording segment may not have flushed yet. Note it and keep going.
        const message = error instanceof Error ? error.message : String(error);
        frameReports.push({ frame: index, faces: 0, error: message });
        continue;
      }

      framesAnalyzed += 1;
      frameReports.push({ frame: index, faces: faces.length, ...(crop ? { crop } : {}) });
      if (faces.length > bestFrameFaces.length) bestFrameFaces = faces;

      for (const face of faces) {
        if (!face.name) continue;
        const existing = bestByName.get(face.name);
        if (!existing || face.similarity > existing.similarity) {
          bestByName.set(face.name, {
            name: face.name,
            similarity: face.similarity,
            margin: face.margin,
            frame: index,
          });
        }
      }

      // Someone cleared every gate: more frames can only confirm what we
      // already know, so don't spend the detector on them.
      if (faces.some((face) => face.name)) break;
    }

    if (framesAnalyzed === 0) {
      writeJson(res, 502, {
        error: "No frame could be analyzed",
        frames: frameReports,
      });
      return;
    }

    const matches = [...bestByName.values()].sort((a, b) => b.similarity - a.similarity);
    const elapsedMs = Date.now() - startedAt;
    log.info(
      {
        framesSubmitted: frames.length,
        framesAnalyzed,
        faceCount: bestFrameFaces.length,
        people: matches.map((m) => m.name),
        elapsedMs,
      },
      "face identify",
    );
    writeJson(res, 200, {
      // Faces that cleared the confidence floor in the frame that saw the most
      // of them — not the detector's raw count, which includes junk detections.
      faceCount: bestFrameFaces.length,
      people: matches.map((match) => match.name),
      // Convenience for automations that only look at one name.
      topPerson: matches[0]?.name ?? null,
      matches,
      faces: bestFrameFaces,
      framesSubmitted: frames.length,
      framesAnalyzed,
      frames: frameReports,
      knownPeople: new Set(centroids.map((c) => c.name)).size,
      elapsedMs,
    });
  } catch (error) {
    if (error instanceof BadRequest) {
      writeJson(res, 400, { error: error.message });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    log.error({ err: message }, "face identify failed");
    if (!res.writableEnded) writeJson(res, 500, { error: message });
  } finally {
    active -= 1;
  }
};
