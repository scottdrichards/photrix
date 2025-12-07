import { DatabaseFileEntry } from "./fileRecord.type.ts";
import { FileRecord } from "./indexDatabase.type.ts";

/**
 * Converts a database row to a FileRecord by parsing JSON fields and reconstructing nested objects
 */
export const rowToFileRecord = (row: Record<string, any>): FileRecord => {
    const record: any = {
        relativePath: row.relativePath,
        mimeType: row.mimeType,
    };

    // File Info
    if (row.sizeInBytes !== null && row.sizeInBytes !== undefined) record.sizeInBytes = row.sizeInBytes;
    if (row.created) record.created = new Date(row.created);
    if (row.modified) record.modified = new Date(row.modified);

    // EXIF Metadata
    if (row.dateTaken) record.dateTaken = new Date(row.dateTaken);
    if (row.dimensionsWidth !== null && row.dimensionsHeight !== null) {
        record.dimensions = { width: row.dimensionsWidth, height: row.dimensionsHeight };
    }
    if (row.locationLatitude !== null && row.locationLongitude !== null) {
        record.location = { latitude: row.locationLatitude, longitude: row.locationLongitude };
    }
    if (row.cameraMake) record.cameraMake = row.cameraMake;
    if (row.cameraModel) record.cameraModel = row.cameraModel;
    if (row.exposureTime) record.exposureTime = row.exposureTime;
    if (row.aperture) record.aperture = row.aperture;
    if (row.iso !== null && row.iso !== undefined) record.iso = row.iso;
    if (row.focalLength) record.focalLength = row.focalLength;
    if (row.lens) record.lens = row.lens;
    if (row.duration !== null && row.duration !== undefined) record.duration = row.duration;
    if (row.framerate !== null && row.framerate !== undefined) record.framerate = row.framerate;
    if (row.videoCodec) record.videoCodec = row.videoCodec;
    if (row.audioCodec) record.audioCodec = row.audioCodec;
    if (row.rating !== null && row.rating !== undefined) record.rating = row.rating;
    if (row.tags) record.tags = JSON.parse(row.tags);
    if (row.orientation !== null && row.orientation !== undefined) record.orientation = row.orientation;

    // AI Metadata
    if (row.aiDescription) record.aiDescription = row.aiDescription;
    if (row.aiTags) record.aiTags = JSON.parse(row.aiTags);

    // Face Metadata
    if (row.faceTags) record.faceTags = JSON.parse(row.faceTags);

    // Processing status
    if (row.thumbnailsReady) record.thumbnailsReady = Boolean(row.thumbnailsReady);
    if (row.fileHash) record.fileHash = row.fileHash;
    if (row.exifProcessedAt) record.exifProcessedAt = row.exifProcessedAt;
    if (row.thumbnailsProcessedAt) record.thumbnailsProcessedAt = row.thumbnailsProcessedAt;

    return record as FileRecord;
}

/**
 * Converts a FileRecord to column names and values for SQL insertion
 */
export const getColumnNamesAndValues = (entry: Partial<DatabaseFileEntry>): { names: string[]; values: any[] } => {
    const names: string[] = [];
    const values: any[] = [];

    const addColumn = (name: string, value: any) => {
        names.push(name);
        values.push(value);
    };

    // Always include relativePath and mimeType
    if (entry.relativePath) addColumn('relativePath', entry.relativePath);
    if (entry.mimeType !== undefined) addColumn('mimeType', entry.mimeType);

    // File Info
    if (entry.sizeInBytes !== undefined) addColumn('sizeInBytes', entry.sizeInBytes);
    if (entry.created !== undefined) addColumn('created', entry.created instanceof Date ? entry.created.toISOString() : entry.created);
    if (entry.modified !== undefined) addColumn('modified', entry.modified instanceof Date ? entry.modified.toISOString() : entry.modified);

    // EXIF Metadata
    if (entry.dateTaken !== undefined) addColumn('dateTaken', entry.dateTaken instanceof Date ? entry.dateTaken.toISOString() : entry.dateTaken);
    if (entry.dimensions) {
        addColumn('dimensionsWidth', entry.dimensions.width);
        addColumn('dimensionsHeight', entry.dimensions.height);
    }
    if (entry.location) {
        addColumn('locationLatitude', entry.location.latitude);
        addColumn('locationLongitude', entry.location.longitude);
    }
    if (entry.cameraMake !== undefined) addColumn('cameraMake', entry.cameraMake);
    if (entry.cameraModel !== undefined) addColumn('cameraModel', entry.cameraModel);
    if (entry.exposureTime !== undefined) addColumn('exposureTime', entry.exposureTime);
    if (entry.aperture !== undefined) addColumn('aperture', entry.aperture);
    if (entry.iso !== undefined) addColumn('iso', entry.iso);
    if (entry.focalLength !== undefined) addColumn('focalLength', entry.focalLength);
    if (entry.lens !== undefined) addColumn('lens', entry.lens);
    if (entry.duration !== undefined) addColumn('duration', entry.duration);
    if (entry.framerate !== undefined) addColumn('framerate', entry.framerate);
    if (entry.videoCodec !== undefined) addColumn('videoCodec', entry.videoCodec);
    if (entry.audioCodec !== undefined) addColumn('audioCodec', entry.audioCodec);
    if (entry.rating !== undefined) addColumn('rating', entry.rating);
    if (entry.tags !== undefined) addColumn('tags', JSON.stringify(entry.tags));
    if (entry.orientation !== undefined) addColumn('orientation', entry.orientation);

    // AI Metadata
    if (entry.aiDescription !== undefined) addColumn('aiDescription', entry.aiDescription);
    if (entry.aiTags !== undefined) addColumn('aiTags', JSON.stringify(entry.aiTags));

    // Face Metadata
    if (entry.faceTags !== undefined) addColumn('faceTags', JSON.stringify(entry.faceTags));

    // Processing status
    if (entry.thumbnailsReady !== undefined) addColumn('thumbnailsReady', entry.thumbnailsReady ? 1 : 0);
    if (entry.fileHash !== undefined) addColumn('fileHash', entry.fileHash);
    if (entry.exifProcessedAt !== undefined) addColumn('exifProcessedAt', entry.exifProcessedAt);
    if (entry.thumbnailsProcessedAt !== undefined) addColumn('thumbnailsProcessedAt', entry.thumbnailsProcessedAt);

    return { names, values };
}