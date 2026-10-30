import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

// Synthetic sources for the playback lab. Every clip is generated from ffmpeg's
// test pattern, so nothing here is a real recording and the files can be
// rebuilt anywhere. They are deliberately shaped like what a phone produces —
// 4K, HEVC, 10-bit, rotated — because that is what makes the on-the-fly
// encoder work hardest.

export type LabClip = {
  /** File name under the lab media root (also the API path). */
  name: string;
  durationS: number;
  /** ffmpeg arguments after `-y`, minus the output path. */
  args: (vaapi: boolean) => string[];
  /** Metadata-only rotation applied by a stream-copy remux, in degrees. */
  rotation?: number;
};

const testPattern = (size: string, fps: number, durationS: number, tone: number) => [
  "-f", "lavfi", "-i", `testsrc2=s=${size}:r=${fps}:d=${durationS}`,
  "-f", "lavfi", "-i", `sine=f=${tone}:d=${durationS}`,
];

const RENDER_NODE = "/dev/dri/renderD128";

// Upscaling the pattern on the GPU keeps generation fast: a CPU scale to 4K
// runs at single-digit frames per second on a busy box.
const hevc4k = (vaapi: boolean, tenBit: boolean, bitrate: string) =>
  vaapi
    ? [
        "-vf", `format=nv12,hwupload,scale_vaapi=3840:2160:format=${tenBit ? "p010" : "nv12"}`,
        "-c:v", "hevc_vaapi", ...(tenBit ? ["-profile:v", "main10"] : []), "-b:v", bitrate,
      ]
    : [
        "-vf", `scale=3840:2160,format=${tenBit ? "yuv420p10le" : "yuv420p"}`,
        "-c:v", "libx265", "-preset", "ultrafast", "-b:v", bitrate,
      ];

export const LAB_CLIPS = {
  short: {
    name: "short-6s-1080p30-h264.mp4",
    durationS: 6,
    args: () => [
      ...testPattern("1920x1080", 30, 6, 440),
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac",
    ],
  },
  medium: {
    name: "medium-90s-4k60-hevc10-portrait.mov",
    durationS: 90,
    rotation: 90,
    args: (vaapi) => [
      ...(vaapi ? ["-vaapi_device", RENDER_NODE] : []),
      ...testPattern("1280x720", 60, 90, 330),
      ...hevc4k(vaapi, true, "40M"), "-tag:v", "hvc1", "-c:a", "aac",
    ],
  },
  long: {
    name: "long-600s-4k30-hevc.mp4",
    durationS: 600,
    args: (vaapi) => [
      ...(vaapi ? ["-vaapi_device", RENDER_NODE] : []),
      ...testPattern("1280x720", 30, 600, 550),
      ...hevc4k(vaapi, false, "20M"), "-tag:v", "hvc1", "-c:a", "aac",
    ],
  },
} satisfies Record<string, LabClip>;

const run = (args: string[]): void => {
  const result = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`ffmpeg failed (${result.status}): ${args.join(" ")}`);
};

/** Builds any lab clip that isn't already in `mediaRoot`. Idempotent. */
export const ensureLabMedia = (mediaRoot: string): void => {
  mkdirSync(mediaRoot, { recursive: true });
  const vaapi = existsSync(RENDER_NODE);
  for (const clip of Object.values(LAB_CLIPS) as LabClip[]) {
    const out = join(mediaRoot, clip.name);
    if (existsSync(out)) continue;
    console.log(`[playback-lab] generating ${clip.name} (${vaapi ? "VAAPI" : "software"})`);
    const tmp = join(mediaRoot, `.tmp-${clip.name}`);
    run([...clip.args(vaapi), tmp]);
    if (clip.rotation) {
      const rotated = join(mediaRoot, `.rot-${clip.name}`);
      run(["-display_rotation", String(clip.rotation), "-i", tmp, "-c", "copy", rotated]);
      renameSync(rotated, tmp);
    }
    renameSync(tmp, out);
  }
};
