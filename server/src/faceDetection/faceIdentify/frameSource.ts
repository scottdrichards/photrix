import { deriveFrigateFrames, DEFAULT_FRIGATE_FRAMES, DEFAULT_FRIGATE_PAD } from "./frigateEventFrames.ts";
import { FaceIdentifyInputError } from "./inputError.ts";
import { fetchPrivate, parsePrivateHostPort, parsePrivateUrl, UnsafeUrlError } from "./ssrfGuard.ts";

/** Largest single image accepted. A 5 MP camera JPEG is ~2 MB; 16 is generous. */
export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

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

/** Lazily-resolved frames: raw bytes are already here, URLs are fetched on demand. */
export type FrameSource = {
  label: string;
  load: () => Promise<Buffer>;
  /** Normalized [x, y, w, h] to crop to before detection, if the caller gave one. */
  box?: readonly number[];
  pad?: number;
};

/** Runs a guarded fetch, reporting a refused URL as the caller's mistake. */
const fetchGuarded = async (url: URL): Promise<Response> => {
  try {
    return await fetchPrivate(url, { timeoutMs: FETCH_TIMEOUT_MS });
  } catch (error) {
    if (error instanceof UnsafeUrlError) throw new FaceIdentifyInputError(error.message);
    throw error;
  }
};

const fetchFrame = async (rawUrl: string): Promise<Buffer> => {
  let url: URL;
  try {
    url = parsePrivateUrl(rawUrl);
  } catch (error) {
    throw new FaceIdentifyInputError((error as Error).message);
  }
  const response = await fetchGuarded(url);
  if (!response.ok) throw new FaceIdentifyInputError(`Frame fetch returned HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) throw new FaceIdentifyInputError("Frame fetch returned an empty body");
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new FaceIdentifyInputError(`Frame exceeds ${MAX_IMAGE_BYTES} bytes`);
  }
  return buffer;
};

const urlFrame = (url: string, box?: readonly number[], pad?: unknown): FrameSource => ({
  label: url,
  load: () => fetchFrame(url),
  ...(box ? { box } : {}),
  ...(typeof pad === "number" ? { pad } : {}),
});

/**
 * Resolves `{"frigateEvent": {...}}` into frames by reading the event record.
 *
 * The caller supplies only the event **id** deliberately. Frigate publishes two
 * different shapes for the same event — MQTT's `frigate/events` payload is flat
 * while the REST record nests the same fields under `data` — and a caller
 * templating its way through the wrong one fails silently, which is exactly how
 * this endpoint's first integration broke. The id is identical in both, so the
 * fragile part happens here, in code that can be tested.
 */
const framesFromFrigateEvent = async (spec: Record<string, unknown>): Promise<FrameSource[]> => {
  const rawHost = typeof spec.host === "string" ? spec.host : null;
  const id = typeof spec.id === "string" ? spec.id : null;
  if (!rawHost || !id) {
    throw new FaceIdentifyInputError("frigateEvent needs both host and id");
  }
  let host: string;
  try {
    host = parsePrivateHostPort(rawHost);
  } catch (error) {
    throw new FaceIdentifyInputError((error as Error).message);
  }

  const response = await fetchGuarded(new URL(`http://${host}/api/events/${encodeURIComponent(id)}`));
  if (!response.ok) {
    throw new FaceIdentifyInputError(`Frigate event lookup returned HTTP ${response.status}`);
  }
  const record = (await response.json()) as Record<string, unknown>;

  const maxFrames = Math.min(
    typeof spec.frames === "number" ? spec.frames : DEFAULT_FRIGATE_FRAMES,
    MAX_FRAMES,
  );
  const frames = deriveFrigateFrames(record, {
    host,
    maxFrames,
    pad: typeof spec.pad === "number" ? spec.pad : DEFAULT_FRIGATE_PAD,
  });
  if (frames.length === 0) {
    throw new FaceIdentifyInputError(
      `Frigate event ${id} carries no box to crop to — nothing worth analyzing`,
    );
  }
  return frames.map((frame) => urlFrame(frame.url, frame.box, frame.pad));
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
  if (typeof entry === "string") return urlFrame(entry);
  if (typeof entry !== "object" || entry === null) {
    throw new FaceIdentifyInputError("Each imageUrls entry must be a URL string or an object");
  }
  const object = entry as Record<string, unknown>;
  if (typeof object.url !== "string") {
    throw new FaceIdentifyInputError("Each imageUrls object needs a url");
  }
  if (object.box !== undefined && !isNormalizedBox(object.box)) {
    throw new FaceIdentifyInputError("box must be four numbers: [x, y, width, height], normalized");
  }
  return urlFrame(object.url, object.box, object.pad);
};

/**
 * Resolves the frames to classify from any accepted request shape: raw bytes
 * with an `image/*` content type, or JSON carrying `frigateEvent`, `imageUrl`,
 * `imageUrls`, or `imageBase64`.
 *
 * URLs stay unfetched until their frame is actually needed, so an early
 * confident match costs one HTTP GET rather than six.
 */
export const framesFromBody = async (contentType: string, body: Buffer): Promise<FrameSource[]> => {
  if (body.length === 0) throw new FaceIdentifyInputError("Empty request body");

  if (contentType.startsWith("image/") || contentType === "application/octet-stream") {
    return [{ label: "body", load: () => Promise.resolve(body) }];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf-8"));
  } catch {
    throw new FaceIdentifyInputError(
      "Body must be image bytes (Content-Type: image/*) or JSON with imageUrl/imageUrls/imageBase64",
    );
  }
  const object = parsed as Record<string, unknown>;

  if (typeof object.frigateEvent === "object" && object.frigateEvent !== null) {
    return framesFromFrigateEvent(object.frigateEvent as Record<string, unknown>);
  }
  if (Array.isArray(object.imageUrls)) {
    if (object.imageUrls.length === 0) throw new FaceIdentifyInputError("imageUrls was empty");
    if (object.imageUrls.length > MAX_FRAMES) {
      throw new FaceIdentifyInputError(`imageUrls accepts at most ${MAX_FRAMES} frames`);
    }
    return object.imageUrls.map(parseFrameEntry);
  }
  if (typeof object.imageUrl === "string") {
    return [urlFrame(object.imageUrl, isNormalizedBox(object.box) ? object.box : undefined, object.pad)];
  }
  if (typeof object.imageBase64 === "string") {
    const bytes = Buffer.from(object.imageBase64.replace(/^data:[^;]+;base64,/, ""), "base64");
    if (bytes.length === 0) throw new FaceIdentifyInputError("imageBase64 decoded to nothing");
    return [{ label: "imageBase64", load: () => Promise.resolve(bytes) }];
  }
  throw new FaceIdentifyInputError(
    "JSON body must contain frigateEvent, imageUrl, imageUrls or imageBase64",
  );
};
