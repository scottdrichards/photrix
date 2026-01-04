import path from "node:path";
import { getExifMetadataFromFile, getFileInfo } from "../fileHandling/fileUtils.ts";
import { mimeTypeForFilename } from "../fileHandling/mimeTypes.ts";
import { IndexDatabase } from "./indexDatabase.ts";

const stripLeadingSlash = (value: string) => value.replace(/^\\?\//, "");

const durationFormatter = new (Intl as any).DurationFormat("en", {
    style: "digital",
    hours: "2-digit",
    minutes: "2-digit",
    seconds: "2-digit",
});


export const processExifMetadata = async (
    database: IndexDatabase,
    batchSize = 200,
): Promise<void> => {
    console.log("[metadata] Starting metadata processing");
    let processed = 0;
    let batchNumber = 0;
    let total = 0;
    const startTime = Date.now();
    let lastLogTime = startTime;
    let lastLogProcessed = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
        const { total: batchTotal, items: pending } = database.getFilesNeedingMetadataUpdate('exif', batchSize);
        total = batchTotal;
        if (!pending.length) {
            break;
        }

        batchNumber++;
        const remainingEstimate = total || processed + pending.length;
        console.log(`[metadata] Batch ${batchNumber}: processing ${pending.length} files (total remaining: ${remainingEstimate}) starting with ${pending[0].relativePath}`);

        for (const entry of pending) {
            const relativePath = entry.relativePath;
            const normalized = stripLeadingSlash(relativePath);
            const fullPath = path.join(database.storagePath, normalized);
            const mimeType = entry.mimeType ?? mimeTypeForFilename(relativePath) ?? null;
            const processedAt = new Date().toISOString();

            try {
                const updates: Record<string, unknown> = {};
                if (!entry.infoProcessedAt) {
                    try {
                        const info = await getFileInfo(fullPath);
                        updates.sizeInBytes = info.sizeInBytes;
                        updates.created = info.created;
                        updates.modified = info.modified;
                    } catch (error) {
                        console.warn(`[metadata] File info failed for ${relativePath}:`, error instanceof Error ? error.message : String(error));
                    }
                    updates.infoProcessedAt = processedAt;
                }

                const isMedia = mimeType?.startsWith("image/") || mimeType?.startsWith("video/");
                if (!entry.exifProcessedAt && isMedia) {
                    try {
                        const exif = await getExifMetadataFromFile(fullPath);
                        Object.assign(updates, exif);
                    } catch (error) {
                        console.warn(`[metadata] EXIF extraction failed for ${relativePath}:`, error instanceof Error ? error.message : String(error));
                    }
                    updates.exifProcessedAt = processedAt;
                }

                if (!entry.exifProcessedAt && !isMedia) {
                    // Not a media file; mark as processed so it doesn't loop forever
                    updates.exifProcessedAt = processedAt;
                }

                if (Object.keys(updates).length) {
                    await database.addOrUpdateFileData(relativePath, updates);
                    processed++;
                }
            } catch (error) {
                console.warn(`[metadata] Failed processing ${relativePath}:`, error instanceof Error ? error.message : String(error));
            }

            const now = Date.now();
            if (now - lastLogTime >= 1000) {
                const elapsedSec = (now - startTime) / 1000;
                const rate = elapsedSec > 0 ? processed / elapsedSec : 0;
                const remaining = Math.max((total || processed) - processed, 0);
                const etaSec = rate > 0 ? remaining / rate : 0;
                const remainingDuration = formatEta(etaSec);
                const deltaProcessed = processed - lastLogProcessed;
                const deltaRate = deltaProcessed / ((now - lastLogTime) / 1000 || 1);
                console.log(`[metadata] Progress: ${processed}/${total || "?"} processed | ~${rate.toFixed(1)} files/s (recent ${deltaRate.toFixed(1)} files/s) | ${remainingDuration} remaining | current ${relativePath}`);
                lastLogTime = now;
                lastLogProcessed = processed;
            }
        }
    }

    console.log(`[metadata] Completed metadata processing. Total updated: ${processed}`);
};

const formatEta = (seconds: number): string => {
    const safeSeconds = Number.isFinite(seconds) && seconds >= 0 ? seconds : 0;
    if (durationFormatter) {
        try {
            return durationFormatter.format({ seconds: safeSeconds });
        } catch {
            // Fall through to string-based formatting
        }
    }
    const hrs = Math.floor(safeSeconds / 3600);
    const mins = Math.floor((safeSeconds % 3600) / 60);
    const secs = Math.floor(safeSeconds % 60);
    const pad = (v: number) => v.toString().padStart(2, "0");
    return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
};
