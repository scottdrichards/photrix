import { spawn } from "child_process";
import type { ExifMetadata } from "../indexDatabase/fileRecord.type.ts";

type FFProbeStream = {
  codec_type?: string;
  width?: number;
  height?: number;
  codec_name?: string;
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
 * Returns the clockwise rotation in degrees (0, 90, 180, or 270) needed to
 * display the video correctly. Returns 0 if no rotation metadata is present.
 */
export const getVideoRotationDegrees = (filePath: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", [
      "-v", "error",
      "-print_format", "json",
      "-show_streams",
      filePath,
    ]);
    let stdout = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.on("close", (code) => {
      if (code !== 0) { reject(new Error(`ffprobe failed for ${filePath}`)); return; }
      try {
        const data = JSON.parse(stdout) as FFProbeOutput;
        resolve(extractRotationDegrees(data.streams ?? []));
      } catch (e) { reject(e); }
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
