import { FileRecord } from "./fileRecord.type.ts";
import { normalizeFolderPath } from "./utils/pathUtils.ts";

/**
 * Converts a database row to a FileRecord by parsing JSON fields and reconstructing nested objects
 */
export const rowToFileRecord = (row: Record<string, string|number>, wantedFields: Array<keyof FileRecord>|'all'='all'): FileRecord => {
    const date = (v:string|number)=>new Date(v);
    const json = (v:string)=>JSON.parse(v);

    // folder and fileName come from the row
    const folder = normalizeFolderPath(row.folder as string);
    const fileName = row.fileName as string;
    if (!folder || !fileName) {
        throw new Error("rowToFileRecord: row is missing folder or fileName");
    }

    const fieldConversions = ["sizeInBytes",
        ["created", date],
        ["modified", date],
        ["dateTaken", date],
        "cameraMake",
        "cameraModel",
        "exposureTime",
        "aperture",
        "iso",
        "focalLength",
        "lens",
        "duration",
        "framerate",
        "videoCodec",
        "audioCodec",
        "rating",
        ["tags",json],
        "orientation",
        "aiDescription",
        ["aiTags", json],
        ["faceTags", json],
        "locationLatitude",
        "locationLongitude",
    ] as const;

    const wantedConversions = wantedFields === 'all' ? fieldConversions : fieldConversions.filter(entry => {
        const field = typeof entry === 'string' ? entry : entry[0];
        return wantedFields.includes(field);
    });

    const basicObject = wantedConversions.map(entry=>{
        const [field, conversionFn] = typeof entry === 'string'? [entry]: entry;
        const rowValue = row[field];
        return {field, rowValue, conversionFn}
    }).reduce((acc,{field, rowValue, conversionFn})=>{
        if (!conversionFn){
            return {...acc, [field]: rowValue}
        }
        return {...acc, [field]:conversionFn(rowValue as string)}
    },{} as Partial<FileRecord>);

    /////////////////
    // Now add row values that have different keys than DB entries.
    const {dimensionsWidth, dimensionsHeight} = row;

    return {
        folder,
        fileName,
        mimeType: (row.mimeType as string | null) ?? null,
        ...basicObject,
        ...(dimensionsWidth !== null && dimensionsWidth !== undefined && { dimensionWidth: dimensionsWidth }),
        ...(dimensionsHeight !== null && dimensionsHeight !== undefined && { dimensionHeight: dimensionsHeight }),
    } as FileRecord;
}

/**
 * Converts a FileRecord to column names and values for SQL insertion
 */
export const fileRecordToColumnNamesAndValues = (entry: FileRecord): { names: string[]; values: (string|number)[] } => {
    const names: string[] = [];
    const values: (string|number)[] = [];

    const addColumn = (name: string, value: string|number|undefined|null) => {
        if (value === undefined || value === null){
            return;
        }
        names.push(name);
        values.push(value);
    };

    addColumn('folder', normalizeFolderPath(entry.folder));
    addColumn('fileName', entry.fileName);
    addColumn('mimeType', entry.mimeType);

    // File Info
    if (entry.infoProcessedAt){
        addColumn('infoProcessedAt', entry.infoProcessedAt);
        addColumn('sizeInBytes', entry.sizeInBytes);
        addColumn('created', entry.created instanceof Date ? entry.created.getTime() : entry.created);
        addColumn('modified', entry.modified instanceof Date ? entry.modified.getTime() : entry.modified);
    }

    // EXIF Metadata
    if (entry.exifProcessedAt){
        addColumn('exifProcessedAt', entry.exifProcessedAt);
        addColumn('dateTaken', entry.dateTaken instanceof Date ? entry.dateTaken.getTime() : entry.dateTaken);
        addColumn('dimensionsWidth', entry.dimensionWidth);
        addColumn('dimensionsHeight', entry.dimensionHeight);
        addColumn('locationLatitude', entry.locationLatitude);
        addColumn('locationLongitude', entry.locationLongitude);
        addColumn('cameraMake', entry.cameraMake);
        addColumn('cameraModel', entry.cameraModel);
        addColumn('exposureTime', entry.exposureTime);
        addColumn('aperture', entry.aperture);
        addColumn('iso', entry.iso);
        addColumn('focalLength', entry.focalLength);
        addColumn('lens', entry.lens);
        addColumn('duration', entry.duration);
        addColumn('framerate', entry.framerate);
        addColumn('videoCodec', entry.videoCodec);
        addColumn('audioCodec', entry.audioCodec);
        addColumn('rating', entry.rating);
        addColumn('tags', JSON.stringify(entry.tags));
        addColumn('orientation', entry.orientation);
    }

    // AI Metadata
    if (entry.aiMetadataProcessedAt){
        addColumn('aiMetadataProcessedAt', entry.aiMetadataProcessedAt);
        addColumn('aiDescription', entry.aiDescription);
        addColumn('aiTags', JSON.stringify(entry.aiTags));
    }

    // Face Metadata
    if (entry.faceMetadataProcessedAt){
        addColumn('faceMetadataProcessedAt', entry.faceMetadataProcessedAt);
        addColumn('faceTags', JSON.stringify(entry.faceTags));
    }

    // Validate that names and values are in sync
    if (names.length !== values.length) {
        throw new Error(
            `Internal error in getColumnNamesAndValues: ${names.length} names but ${values.length} values. ` +
            `Names: ${names.join(', ')}`
        );
    }

    return { names, values };
}