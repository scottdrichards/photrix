import { stat } from "node:fs/promises";
import { exec } from 'node:child_process';
import { MediaDatabase, mediaDatabase, type MediaFileProperties, type MediaFileRow } from "./mediaDatabase";
import { ExifTool } from "exiftool-vendored";
import { readdir } from "node:fs/promises";
import path from "node:path";

const exiftool = new ExifTool({
    taskTimeoutMillis: 5000,
    maxProcs: 2,
    minDelayBetweenSpawnMillis: 500,
});

const processFile = async (fullPath: string, rootDir: string): Promise<MediaFileRow> => {
    const stats = await stat(fullPath);
    const dateModified = stats.mtimeMs;

    const relativePath = path.relative(rootDir, fullPath)

    const existing = mediaDatabase.getFileByPath(relativePath);
    if (existing && existing.date_indexed >= dateModified && !fullPath.includes('7882')) {
        // console.log(`File already indexed: ${relativePath}`);
        return existing;
    }
    try {
        const tags = await exiftool.read(fullPath);
        
        const dateFromExifDate = (
            date: string | number | { toDate: () => Date },
        ): Date => {
            if (typeof date === "object" && "toDate" in date) {
                return date.toDate();
            }
            return new Date(date);
        };

        const parentRelative = path.dirname(relativePath)
        const parent_path = parentRelative === '.' ? '' : parentRelative;

        // Create MediaFileRow from EXIF data
        // Video-specific enrichment via ffprobe (covers duration, dimensions, frame rate)
        let durationSeconds: number | undefined;
        let videoFrameRate: number | undefined;
        // If exiftool already gave us width/height keep them; otherwise we can backfill from probe
        const videoExts = ['.mp4','.mov','.mkv','.avi','.wmv','.flv','.webm','.m4v'];
        const ext = path.extname(fullPath).toLowerCase();
        if (videoExts.includes(ext)) {
            const probeJson = await new Promise<any>(resolve => {
                exec(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height,avg_frame_rate,duration -of json "${fullPath}"`, (err, stdout) => {
                    if (err) return resolve({});
                    try { resolve(JSON.parse(stdout)); } catch { resolve({}); }
                });
            });
            const stream = probeJson.streams?.[0];
            if (stream) {
                if (!('ImageWidth' in tags) && stream.width) (tags as any).ImageWidth = stream.width;
                if (!('ImageHeight' in tags) && stream.height) (tags as any).ImageHeight = stream.height;
                if (stream.avg_frame_rate && typeof stream.avg_frame_rate === 'string' && stream.avg_frame_rate.includes('/')) {
                    const [n,d] = stream.avg_frame_rate.split('/').map(Number); if (d) videoFrameRate = n/d;
                } else if (typeof stream.avg_frame_rate === 'number') videoFrameRate = stream.avg_frame_rate;
                if (stream.duration) durationSeconds = Number(stream.duration);
            }
            if (!durationSeconds && probeJson.format?.duration) {
                const d = Number(probeJson.format.duration); if (!Number.isNaN(d)) durationSeconds = d;
            }
        }

        const properties: MediaFileProperties = {
            name: path.basename(relativePath),
            parent_path,
            date_modified: dateModified,
            date_taken: tags.DateTimeOriginal ? dateFromExifDate(tags.DateTimeOriginal).getTime() : undefined,
            rating: tags.Rating ? Number(tags.Rating) : undefined,
            camera_make: tags.Make ? String(tags.Make) : undefined,
            camera_model: tags.Model ? String(tags.Model) : undefined,
            lens_model: tags.LensModel ? String(tags.LensModel) : undefined,
            focal_length: tags.FocalLength ? String(tags.FocalLength) : undefined,
            aperture: tags.Aperture ? String(tags.Aperture) : undefined,
            shutter_speed: tags.ShutterSpeed ? String(tags.ShutterSpeed) : undefined,
            iso: tags.ISO ? String(tags.ISO) : undefined,
            keywords: Array.isArray(tags.Keywords) ? tags.Keywords : typeof tags.Keywords === "string" ? [tags.Keywords] : undefined,
            hierarchical_subject: tags.HierarchicalSubject?.at(-1) ? String(tags.HierarchicalSubject.at(-1)) : undefined,
            image_width: tags.ImageWidth ? Number(tags.ImageWidth) : undefined,
            image_height: tags.ImageHeight ? Number(tags.ImageHeight) : undefined,
            orientation: tags.Orientation ? Number(tags.Orientation) : undefined,
            gps_latitude: tags.GPSLatitude ? Number(tags.GPSLatitude) : undefined,
            gps_longitude: tags.GPSLongitude ? Number(tags.GPSLongitude) : undefined,
            duration_seconds: durationSeconds ? Math.round(durationSeconds) : undefined,
            video_frame_rate: videoFrameRate ? Math.round(videoFrameRate*1000)/1000 : undefined,
        };

        return mediaDatabase.insertOrUpdateFile(properties);
    } catch (error) {
        console.error(`Error processing file ${relativePath}:`, error);
        
        // If EXIF reading fails, still store basic file info
        const basicFileRow: MediaFileProperties = {
            name: path.basename(relativePath),
            parent_path: path.dirname(relativePath),
            date_modified: dateModified,
        };

        return mediaDatabase.insertOrUpdateFile(basicFileRow);
    }
}

export const processFilesInDirectory = async function* (relativePath: string, rootDir:string, db: MediaDatabase){
    const dirPath = path.join(rootDir, relativePath);
    const foundFolders = await readdir(dirPath, { withFileTypes: true });
    const foundFiles:Array<string> = [];
    const fileBatch: Array<{ name: string, parent_path: string }> = [];
    const BATCH_SIZE = 1000; // Process in batches of 1000 files

    while(foundFolders.length){
        const dirResult = foundFolders.shift()!;
        const currentPath = path.join(dirResult.parentPath, dirResult.name);
        if (dirResult.isDirectory()) {
            const nestedFiles = await readdir(currentPath, { withFileTypes: true });
            foundFolders.push(...nestedFiles);
        } else if (dirResult.isFile()) {
            foundFiles.push(currentPath);
            
            // Add to batch
            fileBatch.push({
                name: path.basename(currentPath),
                parent_path: path.relative(rootDir, path.dirname(currentPath))
            });

            // Process batch when it reaches the batch size
            if (fileBatch.length >= BATCH_SIZE) {
                console.log(`Processing batch of ${BATCH_SIZE} files`);
                console.log(`First file in batch: ${path.join(fileBatch[0].parent_path, fileBatch[0].name)}`);
                db.addBasicFileRows([...fileBatch]);
                fileBatch.length = 0; // Clear the batch
                console.log(`Processed batch of ${BATCH_SIZE} files`);
            }
        } else{
            throw new Error(`Path not a file or folder ${currentPath}`)
        }
    }

    // Process remaining files in batch
    if (fileBatch.length > 0) {
        db.addBasicFileRows([...fileBatch]);
        console.log(`Processed final batch of ${fileBatch.length} files`);
    }

    console.log(`Scanned ${dirPath}, found ${foundFiles.length.toLocaleString()} files`);

    for (const filePath of foundFiles) {
        yield await processFile(filePath, rootDir);
    }
};