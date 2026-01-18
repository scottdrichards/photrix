import { spawn } from "child_process";
import type { ExifMetadata } from "../indexDatabase/fileRecord.type.ts";


export const getVideoMetadata = async (filePath: string): Promise<Partial<ExifMetadata>> => {
  return new Promise((resolve, reject) => {
    const args = [
      "-v", "quiet",
      "-print_format", "json",
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
        const data = JSON.parse(stdout);
        const format = data.format;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const videoStream = data.streams.find((s: any) => s.codec_type === "video");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const audioStream = data.streams.find((s: any) => s.codec_type === "audio");

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
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const sideData = videoStream.side_data_list.find((sd: any) => sd.rotation !== undefined);
            if (sideData && typeof sideData.rotation === 'number') {
              rotate = sideData.rotation;
            }
          }

          if (typeof rotate === 'number' && Number.isFinite(rotate)) {
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
