import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Broken video files for regression tests, made on the spot: generate a clean
 * clip with ffmpeg, then copy it and break the copy the way real files in the
 * library were broken. Nothing is checked in, so there is no fixture to
 * license and no binary in the repo, and every break is a few lines anyone can
 * read.
 *
 * Each kind names the real file it stands for. Add a kind when the library
 * turns up a new way for a video to be broken, and a case for it in the
 * regression specs.
 */

export const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

export const ffmpeg = (args: string[]): void => {
  const result = spawnSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    ...args,
  ]);
  if (result.status !== 0) throw new Error(result.stderr.toString());
};

/**
 * A small, healthy clip: 4 s of moving test pattern at 10 fps, a keyframe
 * every second. `faststart` puts the index (`moov`) before the frames, as
 * phones write it; without it, the index comes last. x264 uses B-frames
 * unless `bFrames` is false.
 */
export const makeClip = (
  dir: string,
  name = "good.mp4",
  {
    faststart = false,
    seconds = 4,
    keyframeEverySeconds = 1,
    bFrames = true,
  }: {
    faststart?: boolean;
    seconds?: number;
    keyframeEverySeconds?: number;
    bFrames?: boolean;
  } = {},
): string => {
  const file = path.join(dir, name);
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    `testsrc=s=160x120:r=10:d=${seconds}`,
    "-g",
    String(10 * keyframeEverySeconds),
    ...(bFrames ? [] : ["-bf", "0"]),
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    ...(faststart ? ["-movflags", "+faststart"] : []),
    file,
  ]);
  return file;
};

/** Byte offset and size of every top-level MP4 box of a kind. */
const findBoxes = (
  bytes: Buffer,
  kind: string,
): Array<{ start: number; size: number }> => {
  const found: Array<{ start: number; size: number }> = [];
  for (let offset = 0; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32BE(offset);
    if (size < 8) break;
    if (bytes.toString("latin1", offset + 4, offset + 8) === kind) {
      found.push({ start: offset, size });
    }
    offset += size;
  }
  return found;
};

export const BROKEN_VIDEO_KINDS = {
  /**
   * The start of a clip with the rest missing, so there is no `moov` index.
   * Real: iPhone clips in an import folder, copied before they finished
   * (2026-10-26, 47 files). ffmpeg: "moov atom not found".
   */
  cutBeforeIndex: (source: Buffer) => source.subarray(0, 4_096),
  /** Real: zero-byte placeholders left by an interrupted copy. */
  empty: () => Buffer.alloc(0),
  /**
   * A whole container with nothing decodable in it: the index is fine, the
   * frame data is zeroed. Stands for an iPhone HEIC photo saved as `.MOV`
   * (2026-10-26): ffmpeg opens it but its chosen stream decodes to nothing.
   * ffmpeg: "Nothing was written into output file".
   */
  blankFrames: (source: Buffer) => {
    const copy = Buffer.from(source);
    for (const { start, size } of findBoxes(copy, "mdat")) {
      copy.fill(0, start + 8, start + size);
    }
    return copy;
  },
  /** Not a media file at all, with a video name. */
  notAVideo: () => Buffer.from("not a video\n"),
} as const;

export type BrokenVideoKind = keyof typeof BROKEN_VIDEO_KINDS;

/**
 * A broken copy of `source`, written into `dir`. `blankFrames` needs a
 * faststart source, so its index survives in front of the zeroed frames.
 */
export const breakVideo = (
  source: string,
  dir: string,
  kind: BrokenVideoKind,
  name: string = kind,
): string => {
  const file = path.join(dir, `${name}${path.extname(source)}`);
  writeFileSync(file, BROKEN_VIDEO_KINDS[kind](readFileSync(source)));
  return file;
};

/**
 * A copy of `source` whose index (`stss`, the sync-sample table) lists only
 * its first keyframe, while the stream still holds all of them. Reading by
 * the index alone then finds one frame. Not a file seen in the library: it
 * stands for any whose muxer flags fewer keyframes than the encoder made,
 * which 6 of 30 library clips do to a lesser degree (2026-10-27: an h264
 * clip gave 20 frames through its index against 30 decoded).
 */
export const indexOnlyFirstKeyframe = (
  source: string,
  dir: string,
  name: string,
): string => {
  const bytes = Buffer.from(readFileSync(source));
  const at = bytes.indexOf("stss", 0, "latin1");
  if (at < 4) throw new Error(`${source} has no stss box`);
  // size, "stss", version+flags, entry count, then the entries.
  bytes.writeUInt32BE(1, at + 8);
  const file = path.join(dir, `${name}${path.extname(source)}`);
  writeFileSync(file, bytes);
  return file;
};
