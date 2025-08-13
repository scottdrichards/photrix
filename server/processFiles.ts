import { stat } from "node:fs/promises";
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
    if (existing && existing.date_indexed >= dateModified) {
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
            hierarchical_subject: tags.HierarchicalSubject?.at(-1) ? String(tags.HierarchicalSubject.at(-1)) : undefined,
            image_width: tags.ImageWidth ? Number(tags.ImageWidth) : undefined,
            image_height: tags.ImageHeight ? Number(tags.ImageHeight) : undefined,
            orientation: tags.Orientation ? Number(tags.Orientation) : undefined,
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
    const dirPath = path.join(relativePath, rootDir);
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