import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { logFailure } from "../../common/logFailure.ts";
import { config } from "../../config/config.ts";
import type { DetectedFace } from "../faceDetector.type.ts";
import { cropToBox, decodedSizeOf, DEFAULT_CROP_PAD, type CropRect } from "./frameImage.ts";
import type { FrameSource } from "./frameSource.ts";
import {
  identifyFaces,
  type IdentifiedFace,
  type IdentifyOptions,
  type PreparedCentroid,
} from "./identifyFaces.ts";
import { FaceIdentifyInputError } from "./inputError.ts";

/** The detector: `imageAnalysis/`'s `analyzeImage`. */
export type AnalyzeImage = (
  imagePath: string,
  options: { faces: boolean; embed: boolean; foreground?: boolean },
) => Promise<{ faces?: DetectedFace[]; facesError?: string }>;

/** What identification runs on, supplied by the caller so this module stays free of the worker plumbing. */
export type IdentifyDeps = {
  analyzeImage: AnalyzeImage;
  /**
   * True when the detector failed because its worker was killed to free the
   * GPU for a user (`taskOrchestrator`'s `isWorkerEvictedError`): worth one retry.
   */
  isWorkerEvicted: (error: unknown) => boolean;
  log: { info: (message: string) => void; warn: (details: object, message: string) => void };
};

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

/**
 * Claims one of the identify slots, returning its release, or null when all
 * are busy.
 */
export const tryClaimIdentifySlot = (): (() => void) | null => {
  if (active >= MAX_ACTIVE) return null;
  active += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active -= 1;
  };
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
  { analyzeImage, isWorkerEvicted, log }: IdentifyDeps,
): Promise<DetectedFace[]> => {
  const tempDir = path.join(config().media.cacheDir, "face-identify");
  await mkdir(tempDir, { recursive: true });
  // The worker takes a path, not a buffer: it shares one decode between the
  // face and CLIP passes and is fed from disk everywhere else.
  const tempPath = path.join(tempDir, `${randomUUID()}.img`);
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
        const analysis = await analyzeImage(tempPath, { faces: true, embed: false, foreground: true });
        if (analysis.facesError) throw new Error(analysis.facesError);
        return analysis.faces ?? [];
      } catch (error) {
        if (attempt > 0 || !isWorkerEvicted(error)) throw error;
        log.info("Analysis worker was evicted for a user GPU request; retrying frame");
        await new Promise((resolve) => setTimeout(resolve, EVICTION_RETRY_DELAY_MS));
      }
    }
  } finally {
    await rm(tempPath, { force: true }).catch(logFailure(log, "Could not remove a temporary frame"));
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

type FrameReport = { frame: number; faces: number; crop?: CropRect; error?: string };

export type IdentifyResult =
  | {
      ok: true;
      /**
       * Faces that cleared the confidence floor in the frame that saw the most
       * of them — not the detector's raw count, which includes junk detections.
       */
      faceCount: number;
      people: string[];
      /** Convenience for automations that only look at one name. */
      topPerson: string | null;
      matches: Match[];
      faces: IdentifiedFace[];
      framesSubmitted: number;
      framesAnalyzed: number;
      frames: FrameReport[];
      knownPeople: number;
    }
  /** Not one frame could be analyzed. */
  | { ok: false; frames: FrameReport[] };

/**
 * Who is in these frames? Runs the detector over each and scores every face
 * against the named people's centroids. Nothing is written: the frames are
 * scored and thrown away, never indexed, and the faces never join a cluster.
 *
 * Frames are walked in order and the walk stops early on a confident,
 * unambiguous match, so the common case (the visitor's face is in the first
 * frame sampled) costs one detector pass while the awkward case still gets
 * every frame it needs.
 *
 * Throws `FaceIdentifyInputError` when the only frame was the caller's mistake.
 */
export const identifyFrames = async (
  {
    frames,
    centroids,
    options,
  }: {
    frames: FrameSource[];
    centroids: PreparedCentroid[];
    options: Omit<IdentifyOptions, "decodedSize">;
  },
  deps: IdentifyDeps,
): Promise<IdentifyResult> => {
  const bestByName = new Map<string, Match>();
  const frameReports: FrameReport[] = [];
  // Faces of the frame that saw the most of them — the one worth rendering a
  // box overlay from, and the best single estimate of how many people were
  // actually there.
  let bestFrameFaces: IdentifiedFace[] = [];
  let framesAnalyzed = 0;

  for (const [index, frame] of frames.entries()) {
    let faces: IdentifiedFace[];
    let crop: CropRect | undefined;
    try {
      let bytes = await frame.load();
      if (frame.box) {
        const cropped = await cropToBox(bytes, frame.box, frame.pad ?? DEFAULT_CROP_PAD);
        bytes = cropped.bytes;
        crop = cropped.rect;
      }
      const [detected, decodedSize] = await Promise.all([
        analyzeFrame(bytes, deps),
        decodedSizeOf(bytes),
      ]);
      faces = identifyFaces(detected, centroids, { ...options, decodedSize });
    } catch (error) {
      if (error instanceof FaceIdentifyInputError && framesAnalyzed === 0 && frames.length === 1) {
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

  if (framesAnalyzed === 0) return { ok: false, frames: frameReports };

  const matches = [...bestByName.values()].sort((a, b) => b.similarity - a.similarity);
  return {
    ok: true,
    faceCount: bestFrameFaces.length,
    people: matches.map((match) => match.name),
    topPerson: matches[0]?.name ?? null,
    matches,
    faces: bestFrameFaces,
    framesSubmitted: frames.length,
    framesAnalyzed,
    frames: frameReports,
    knownPeople: new Set(centroids.map((c) => c.name)).size,
  };
};
