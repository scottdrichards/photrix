import path from "node:path";
import { getExifMetadataFromFile, getFileInfo } from "../fileHandling/fileUtils.ts";
import { mimeTypeForFilename } from "../fileHandling/mimeTypes.ts";
import { IndexDatabase } from "./indexDatabase.ts";
import { BaseFileRecord, FileRecord } from "./fileRecord.type.ts";

const stripLeadingSlash = (value: string) => value.replace(/^\\?\//, "");

const durationFormatter = new (Intl as any).DurationFormat("en");

let isProcessingExif = false;
export const startBackgroundProcessExifMetadata = (database: IndexDatabase, onComplete?: () => void) => {
    if (isProcessingExif) {
        // Just for deugging - should never happen in practice
        throw new Error("EXIF processing is already running");
    }
    isProcessingExif = true;
    const totalToProcess = database.countFilesNeedingMetadataUpdate('exif');
    let processedCount = 0;
    let restartAtMS: number = 0;
    let lastReportTime = Date.now();
    let lastReportCount = 0;

    const processAll = async ()=>{
        while (true) {
            const batchSize = 200;
            const items = database.getFilesNeedingMetadataUpdate('exif', batchSize);
            if (items.length === 0) {
                console.log("[metadata] EXIF processing complete");
                onComplete?.();
                return;
            }
            for (const entry of items) {
                const { relativePath } = entry;
                const fullPath = path.join(database.storagePath, stripLeadingSlash(relativePath));
                let metadata:Omit<FileRecord, keyof BaseFileRecord> = {};
                const fileInfo = await getFileInfo(fullPath);
                const now = new Date();
                metadata = { ...fileInfo, infoProcessedAt: now.toISOString() };
                if (fileInfo.sizeInBytes) {
                    const exif = await getExifMetadataFromFile(fullPath);
                    metadata = { ...metadata, ...exif, exifProcessedAt: now.toISOString() };
                }else{
                    const errorDate = new Date();
                    metadata = { ...metadata, exifProcessedAt: errorDate.toISOString() };
                    console.log(`[metadata] Skipping EXIF for zero-byte file: ${relativePath}`);
                };
                processedCount++;
                if (now.getTime() - lastReportTime > 1000) {
                    const percentComplete = ((processedCount / totalToProcess) * 100).toFixed(2);
                    const rate = (processedCount - lastReportCount) / ((now.getTime() - lastReportTime) / 1000);
                    lastReportCount = processedCount;
                    console.log(`[metadata] ${percentComplete}% complete. ${rate.toFixed(2)} items/sec. Last processed: ${relativePath}`);
                    lastReportTime = now.getTime();
                }
                while (restartAtMS && restartAtMS > Date.now()) {
                    console.log("[metadata] Paused EXIF processing...");
                    const timeoutDuration = restartAtMS - Date.now();
                    await new Promise((resolve) => setTimeout(resolve, timeoutDuration));
                }
            }
        }
    }

    processAll();
    
    const pause = (durationMS: number =  10_000) => {
        const localRestartMs = Date.now() + durationMS;
        restartAtMS = Math.max(restartAtMS, localRestartMs);
    }
    return pause;
}