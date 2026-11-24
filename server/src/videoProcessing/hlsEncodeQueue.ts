import { existsSync } from "node:fs";
import type { TaskOrchestrator } from "../taskOrchestrator/taskOrchestrator.ts";
import { getLogger } from "../observability/logger.ts";
import { recordServerDiagnosticEvent } from "../observability/diagnosticsStore.ts";
import { generateVariantHLS, getVariantSegmentPath } from "./generateMultibitrateHLS.ts";
import { claimVariantEncode, registerHlsProcess } from "./hlsSession.ts";
import { segmentFileName } from "./hlsSegmentNames.ts";

const hlsLog = getLogger("HLS");

export type EncodeTarget = {
  /** Absolute path of the source video. */
  sourcePath: string;
  /** Library-relative path, for diagnostics. */
  subPath: string;
  hlsDir: string;
  variantHeight: number;
  taskOrchestrator: Pick<TaskOrchestrator, "addTask" | "getDiagnosticsSnapshot">;
};

/**
 * Ensures an encode is running that will produce `segmentIndex` of the variant
 * soon.
 *
 * A new encode starts at the requested segment, not at 0, so a seek or a
 * quality switch late in a long video doesn't wait for everything before it to
 * be re-encoded (see claimVariantEncode). Segments already on disk are kept:
 * every encode stamps segment N with the same timestamps (see seekStartArgs),
 * so output from different encodes splices cleanly. With no `segmentIndex`
 * (the EVENT-playlist path) any live encode counts.
 *
 * Queued as a user-blocking task, so playback never waits behind background
 * work. The output is ephemeral — served while the player fetches, then reaped
 * once that variant goes idle (an ABR switch away) or the whole tree goes idle,
 * so no DB marker is persisted.
 */
export const ensureVariantEncoding = (target: EncodeTarget, segmentIndex?: number): void => {
  const { sourcePath, subPath, hlsDir, variantHeight, taskOrchestrator } = target;
  const claim = claimVariantEncode(hlsDir, variantHeight, segmentIndex, (index) =>
    existsSync(getVariantSegmentPath(hlsDir, variantHeight, segmentFileName(index))),
  );
  if (!claim) return;
  const { startSegment, runId } = claim;
  recordServerDiagnosticEvent({
    level: "warn",
    event: "video.hls.encode.queued",
    message: `Queued ${variantHeight}p encode from segment ${startSegment}`,
    data: {
      path: subPath,
      hlsDir,
      variantHeight,
      startSegment,
      queueSnapshot: taskOrchestrator.getDiagnosticsSnapshot(),
    },
  });
  taskOrchestrator.addTask(
    {
      name: `HLS encode ${variantHeight}p`,
      type: "videoConversion",
      start: () => {
        const promise = generateVariantHLS(sourcePath, variantHeight, {
          startSegment,
          onSpawn: (child) => registerHlsProcess(hlsDir, variantHeight, child, runId),
        }).then(
          () => {},
          (error) => {
            // A reaped session/variant kills ffmpeg on purpose; expected for
            // ephemeral HLS, not a real failure.
            hlsLog.debug({ err: error, hlsDir, variantHeight }, "HLS encode ended early");
          },
        );
        return {
          onComplete: async () => {
            await promise;
          },
        };
      },
    },
    "blocking",
  );
};
