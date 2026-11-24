import type * as http from "http";
import type { IndexDatabase } from "../../indexDatabase/indexDatabase.ts";
import type { CropBox, ImageOutputFormat } from "../../imageProcessing/convertImage.ts";
import type { StandardHeight } from "../../common/standardHeights.ts";
import type { TaskOrchestrator } from "../../taskOrchestrator/taskOrchestrator.ts";
import { writeJson } from "../../common/writeJson.ts";

/** One parsed, access-checked `/api/files/<file>` request. */
export type FileHandlingContext = {
  req: http.IncomingMessage;
  url: URL;
  normalizedPath: string;
  subPath: string;
  height: StandardHeight;
  res: http.ServerResponse;
  representation: string | null;
  outputFormat: ImageOutputFormat;
  needsResize: boolean;
  needsFormatChange: boolean;
  isImage: boolean;
  isVideo: boolean;
  crop: CropBox | null;
  /** `t`: which frame of a video a `crop` is of, in ms. Only set for videos. */
  frameTimeMs: number | null;
  database: IndexDatabase;
  taskOrchestrator: TaskOrchestrator;
};

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const unsupported = (res: http.ServerResponse, message: string) =>
  writeJson(res, 415, { error: "Unsupported Media Type", message });

/**
 * Parses a `crop=x,y,w,h` query param of normalized top-left fractions (0..1)
 * of the EXIF-oriented image. Returns null when absent, or throws a message when
 * malformed so the caller can respond with 400.
 */
export const parseCrop = (raw: string | null): CropBox | null => {
  if (raw === null) return null;
  const parts = raw.split(",").map((p) => Number.parseFloat(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error("crop must be four comma-separated numbers: x,y,w,h");
  }
  const [x, y, width, height] = parts;
  if (width <= 0 || height <= 0) {
    throw new Error("crop width and height must be positive");
  }
  if (x < 0 || y < 0 || x >= 1 || y >= 1) {
    throw new Error("crop x and y must be in [0, 1)");
  }
  return { x, y, width, height };
};

/**
 * Parses `t`, the frame of a video that a `crop` refers to, in ms from the
 * start. Returns null when absent; throws when malformed.
 */
export const parseFrameTime = (raw: string | null): number | null => {
  if (raw === null) return null;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms < 0) {
    throw new Error("t must be a non-negative number of milliseconds");
  }
  return Math.round(ms);
};
