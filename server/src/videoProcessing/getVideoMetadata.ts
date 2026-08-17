import { spawn } from "child_process";
import type { ExifMetadata } from "../indexDatabase/fileRecord.type.ts";

type FFProbeStream = {
  codec_type?: string;
  width?: number;
  height?: number;
  codec_name?: string;
  pix_fmt?: string;
  r_frame_rate?: string;
  tags?: {
    rotate?: string;
  };
  side_data_list?: Array<{
    rotation?: number;
  }>;
};

type FFProbeOutput = {
  format?: {
    duration?: string;
    tags?: {
      creation_time?: string;
    };
  };
  streams?: FFProbeStream[];
};

const extractRotationDegrees = (streams: FFProbeStream[]): number => {
  const videoStream = streams.find((s) => s.codec_type === "video");
  if (!videoStream) return 0;

  let raw: number | undefined;
  if (videoStream.tags?.rotate) {
    raw = Number(videoStream.tags.rotate);
  } else if (videoStream.side_data_list) {
    const sd = videoStream.side_data_list.find((d) => d.rotation !== undefined);
    if (sd?.rotation !== undefined) raw = sd.rotation;
  }
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  return ((Math.round(raw) % 360) + 360) % 360;
};

/**
 * The properties of a source video that decide which transcode pipeline can be
 * used for it: how it must be rotated for display, whether the GPU can decode
 * its codec at all, and — critically for the VAAPI path — how many bits per
 * component its decoded surfaces carry. A 10-bit surface downloaded as if it
 * were 8-bit yields silent garbage rather than an error, so the pixel format
 * has to be known before the filter chain is built.
 */
export type VideoSourceProfile = {
  /** Clockwise rotation in degrees (0, 90, 180, 270) needed to display correctly. */
  rotation: number;
  /** ffmpeg codec name of the video stream ("h264", "hevc", …), or "" if unknown. */
  codec: string;
  /** ffmpeg pixel format of the video stream ("yuv420p", "yuv420p10le", …), or "". */
  pixelFormat: string;
};

/**
 * True when the source decodes to more than 8 bits per component ("yuv420p10le",
 * "p010le", …), which VAAPI represents as P010 surfaces rather than NV12. Depth
 * is spelled as a trailing bit count plus endianness in every such ffmpeg format
 * name; plain 8-bit names ("yuv420p", "nv12") carry no such suffix.
 */
export const isHighBitDepthPixelFormat = (pixelFormat: string): boolean =>
  /(10|12|16)(le|be)$/.test(pixelFormat);

/**
 * Probes rotation, codec and pixel format in a single ffprobe call. One probe
 * rather than one per property: every HLS variant start pays this latency
 * before ffmpeg can even be spawned.
 */
export const getVideoSourceProfile = (
  filePath: string,
): Promise<VideoSourceProfile> =>
  new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_streams",
      filePath,
    ]);
    let stdout = "";
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe failed for ${filePath}`));
        return;
      }
      try {
        const data = JSON.parse(stdout) as FFProbeOutput;
        const streams = data.streams ?? [];
        const video = streams.find((s) => s.codec_type === "video");
        resolve({
          rotation: extractRotationDegrees(streams),
          codec: video?.codec_name ?? "",
          pixelFormat: video?.pix_fmt ?? "",
        });
      } catch (e) {
        reject(e);
      }
    });
    proc.on("error", reject);
  });


export const getVideoMetadata = async (
  filePath: string,
): Promise<Partial<ExifMetadata>> => {
  return new Promise((resolve, reject) => {
    const args = [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      filePath,
    ];

    const process = spawn("ffprobe", args);
    let stdout = "";
    let stderr = "";

    process.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    process.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    process.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe failed: ${stderr}`));
        return;
      }

      try {
        const data = JSON.parse(stdout) as FFProbeOutput;
        const format = data.format;
        const streams = data.streams ?? [];
        const videoStream = streams.find((s) => s.codec_type === "video");
        const audioStream = streams.find((s) => s.codec_type === "audio");

        const metadata: Partial<ExifMetadata> = {};

        if (format && format.tags) {
          if (format.tags.creation_time) {
            metadata.dateTaken = new Date(format.tags.creation_time);
          }
        }

        if (format && format.duration) {
          metadata.duration = parseFloat(format.duration);
        }

        if (videoStream) {
          let width = videoStream.width;
          let height = videoStream.height;
          let rotate: number | undefined;

          if (videoStream.tags && videoStream.tags.rotate) {
            rotate = Number(videoStream.tags.rotate);
          } else if (videoStream.side_data_list) {
            const sideData = videoStream.side_data_list.find(
              (sd) => sd.rotation !== undefined,
            );
            if (sideData && typeof sideData.rotation === "number") {
              rotate = sideData.rotation;
            }
          }

          if (typeof rotate === "number" && Number.isFinite(rotate)) {
            // Normalize rotation to 0-360 positive
            rotate = ((rotate % 360) + 360) % 360;

            if (rotate === 90) metadata.orientation = 6;
            else if (rotate === 180) metadata.orientation = 3;
            else if (rotate === 270) metadata.orientation = 8;

            // FFmpeg auto-rotates output, so stored dimensions should reflect display dimensions
            if (rotate === 90 || rotate === 270) {
              [width, height] = [height, width];
            }
          }

          metadata.dimensionWidth = width;
          metadata.dimensionHeight = height;
          metadata.videoCodec = videoStream.codec_name;
          if (videoStream.r_frame_rate) {
            const [num, den] = videoStream.r_frame_rate.split("/");
            metadata.framerate = den ? parseInt(num) / parseInt(den) : parseInt(num);
          }
        }

        if (audioStream) {
          metadata.audioCodec = audioStream.codec_name;
        }

        resolve(metadata);
      } catch (e) {
        reject(e);
      }
    });

    process.on("error", (err) => {
      reject(err);
    });
  });
};
