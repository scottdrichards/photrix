import type * as http from "node:http";
import {
  DEFAULT_IDENTIFY_THRESHOLD,
  DEFAULT_MIN_FACE_CONFIDENCE,
  DEFAULT_MIN_FACE_PIXELS,
  DEFAULT_MIN_MARGIN,
  DEFAULT_STRONG_THRESHOLD,
} from "../people/identify/identifyFaces.ts";
import { getNamedCentroids } from "../people/identify/centroidCache.ts";
import { framesFromBody, MAX_IMAGE_BYTES } from "../people/identify/frameSource.ts";
import {
  identifyFrames,
  tryClaimIdentifySlot,
  type AnalyzeImage,
} from "../people/identify/identifyFrames.ts";
import { FaceIdentifyInputError } from "../people/identify/inputError.ts";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { getLogger } from "../observability/logger.ts";
import { isWorkerEvictedError } from "../taskOrchestrator/computeWorkers.ts";
import { writeJson } from "../common/writeJson.ts";

const log = getLogger("faceIdentify");

const readBodyBytes = (req: http.IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_IMAGE_BYTES) {
        reject(new FaceIdentifyInputError(`Body exceeds ${MAX_IMAGE_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

const numberParam = (params: URLSearchParams, key: string, fallback: number): number => {
  const raw = params.get(key);
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
};

type FaceIdentifyDeps = {
  database: Pick<IndexDatabase, "faceClusters">;
  analyzeImage: AnalyzeImage;
};

/**
 * `GET /api/faces/people` — who can be recognized; `POST /api/faces/identify`
 * — who is in these pictures? The work is in `faceDetection/faceIdentify/`.
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
  const loadNamedCentroids = () => database.faceClusters.getNamedFaceCentroids();

  if (url.pathname === "/api/faces/people" && req.method === "GET") {
    const centroids = await getNamedCentroids(loadNamedCentroids);
    const names = [...new Set(centroids.map((c) => c.name))].sort();
    writeJson(res, 200, { people: names, centroids: centroids.length });
    return;
  }

  if (url.pathname !== "/api/faces/identify" || req.method !== "POST") {
    writeJson(res, 404, { error: "Not found" });
    return;
  }

  const release = tryClaimIdentifySlot();
  if (!release) {
    res.setHeader("Retry-After", "2");
    writeJson(res, 429, {
      error: "Face identification is busy",
      faceCount: 0,
      people: [],
    });
    return;
  }

  const startedAt = Date.now();
  try {
    const contentType = (req.headers["content-type"] ?? "").toString();
    const frames = await framesFromBody(contentType, await readBodyBytes(req));
    const centroids = await getNamedCentroids(loadNamedCentroids);
    const params = url.searchParams;
    const result = await identifyFrames(
      {
        frames,
        centroids,
        options: {
          threshold: numberParam(params, "threshold", DEFAULT_IDENTIFY_THRESHOLD),
          minMargin: numberParam(params, "minMargin", DEFAULT_MIN_MARGIN),
          strongThreshold: numberParam(params, "strongThreshold", DEFAULT_STRONG_THRESHOLD),
          minFaceConfidence: numberParam(params, "minFaceConfidence", DEFAULT_MIN_FACE_CONFIDENCE),
          minFacePixels: numberParam(params, "minFacePixels", DEFAULT_MIN_FACE_PIXELS),
        },
      },
      { analyzeImage, isWorkerEvicted: isWorkerEvictedError, log },
    );

    if (!result.ok) {
      writeJson(res, 502, { error: "No frame could be analyzed", frames: result.frames });
      return;
    }

    const { ok: _ok, ...body } = result;
    const elapsedMs = Date.now() - startedAt;
    log.info(
      {
        framesSubmitted: body.framesSubmitted,
        framesAnalyzed: body.framesAnalyzed,
        faceCount: body.faceCount,
        people: body.people,
        elapsedMs,
      },
      "face identify",
    );
    writeJson(res, 200, { ...body, elapsedMs });
  } catch (error) {
    if (error instanceof FaceIdentifyInputError) {
      writeJson(res, 400, { error: error.message });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    log.error({ err: message }, "face identify failed");
    if (!res.writableEnded) writeJson(res, 500, { error: message });
  } finally {
    release();
  }
};
