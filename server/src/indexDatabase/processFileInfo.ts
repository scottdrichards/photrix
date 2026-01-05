import path from "node:path";
import { getFileInfo } from "../fileHandling/fileUtils.ts";
import { IndexDatabase } from "./indexDatabase.ts";

const stripLeadingSlash = (value: string) => value.replace(/^\\?\//, "");

let isProcessingFileInfo = false;

export const startBackgroundProcessFileInfoMetadata = (database: IndexDatabase, onComplete?: () => void) => {
    if (isProcessingFileInfo) {
        // Just for debugging - should never happen in practice
        throw new Error("File info processing is already running");
    }

    isProcessingFileInfo = true;
    const totalToProcess = database.countFilesNeedingMetadataUpdate("info");
    let processedCount = 0;
    let restartAtMS = 0;
    let lastReportTime = Date.now();
    let lastReportCount = 0;

    const processAll = async () => {
        while (true) {
            const batchSize = 200;
            const items = database.getFilesNeedingMetadataUpdate("info", batchSize);
            if (!items.length) {
                console.log("[metadata] File info processing complete");
                onComplete?.();
                return;
            }

            for (const entry of items) {
                const { relativePath } = entry;
                const fullPath = path.join(database.storagePath, stripLeadingSlash(relativePath));

                const fileInfo = await getFileInfo(fullPath);
                const now = new Date();
                const metadata = { ...fileInfo, infoProcessedAt: now.toISOString() };

                await database.addOrUpdateFileData(relativePath, metadata);

                processedCount++;
                if (now.getTime() - lastReportTime > 1000) {
                    const percentComplete = ((processedCount / totalToProcess) * 100).toFixed(2);
                    const rate = (processedCount - lastReportCount) / ((now.getTime() - lastReportTime) / 1000);
                    lastReportCount = processedCount;
                    console.log(
                        `[metadata] ${percentComplete}% complete. ${rate.toFixed(2)} items/sec. Last processed: ${relativePath}`,
                    );
                    lastReportTime = now.getTime();
                }

                while (restartAtMS && restartAtMS > Date.now()) {
                    console.log("[metadata] Paused file info processing...");
                    const timeoutDuration = restartAtMS - Date.now();
                    await new Promise((resolve) => setTimeout(resolve, timeoutDuration));
                }
            }
        }
    };

    processAll();

    const pause = (durationMS: number = 10_000) => {
        const localRestartMs = Date.now() + durationMS;
        restartAtMS = Math.max(restartAtMS, localRestartMs);
    };

    return pause;
};