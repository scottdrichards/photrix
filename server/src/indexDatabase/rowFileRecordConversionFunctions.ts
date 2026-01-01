import { DatabaseEntry } from "./fileRecord.type.ts";
import { FileRecord } from "./indexDatabase.type.ts";
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
    const {dimensionsWidth, dimensionsHeight, locationLatitude, locationLongitude} = row;

    const location = (()=>{
        if (locationLatitude && locationLongitude){
            return {latitude:locationLatitude, longitude: locationLongitude};
        }
    })()

    return {
        folder,
        fileName,
        mimeType: (row.mimeType as string | null) ?? null,
        ...basicObject,
        ...(dimensionsWidth !== null && dimensionsWidth !== undefined && { dimensionWidth: dimensionsWidth }),
        ...(dimensionsHeight !== null && dimensionsHeight !== undefined && { dimensionHeight: dimensionsHeight }),
        ...location,
    } as FileRecord;
}

/**
 * Converts a FileRecord to column names and values for SQL insertion
 */
export const fileRecordToColumnNamesAndValues = (entry: Partial<DatabaseEntry>): { names: string[]; values: (string|number)[] } => {
    const names: string[] = [];
    const values: (string|number)[] = [];

    const addColumn = (name: string, value: string|number|undefined|null) => {
        if (value === undefined || value === null){
            return;
        }
        names.push(name);
        values.push(value);
    };

    // Use normalized folder and fileName
    if (entry.folder) addColumn('folder', normalizeFolderPath(entry.folder));
    if (entry.fileName) addColumn('fileName', entry.fileName);
    if (entry.mimeType) addColumn('mimeType', entry.mimeType);

    // File Info
    if (entry.sizeInBytes) addColumn('sizeInBytes', entry.sizeInBytes);
    if (entry.created) addColumn('created', entry.created instanceof Date ? entry.created.getTime() : entry.created);
    if (entry.modified) addColumn('modified', entry.modified instanceof Date ? entry.modified.getTime() : entry.modified);

    // EXIF Metadata
    if (entry.dateTaken) addColumn('dateTaken', entry.dateTaken instanceof Date ? entry.dateTaken.getTime() : entry.dateTaken);
    if (entry.dimensionWidth) addColumn('dimensionsWidth', entry.dimensionWidth);
    if (entry.dimensionHeight) addColumn('dimensionsHeight', entry.dimensionHeight);
    if (entry.locationLatitude) addColumn('locationLatitude', entry.locationLatitude);
    if (entry.locationLongitude) addColumn('locationLongitude', entry.locationLongitude);
    if (entry.cameraMake) addColumn('cameraMake', entry.cameraMake);
    if (entry.cameraModel) addColumn('cameraModel', entry.cameraModel);
    if (entry.exposureTime) addColumn('exposureTime', entry.exposureTime);
    if (entry.aperture) addColumn('aperture', entry.aperture);
    if (entry.iso) addColumn('iso', entry.iso);
    if (entry.focalLength) addColumn('focalLength', entry.focalLength);
    if (entry.lens) addColumn('lens', entry.lens);
    if (entry.duration) addColumn('duration', entry.duration);
    if (entry.framerate) addColumn('framerate', entry.framerate);
    if (entry.videoCodec) addColumn('videoCodec', entry.videoCodec);
    if (entry.audioCodec) addColumn('audioCodec', entry.audioCodec);
    if (entry.rating) addColumn('rating', entry.rating);
    if (entry.tags) addColumn('tags', JSON.stringify(entry.tags));
    if (entry.orientation) addColumn('orientation', entry.orientation);

    // AI Metadata
    if (entry.aiDescription) addColumn('aiDescription', entry.aiDescription);
    if (entry.aiTags) addColumn('aiTags', JSON.stringify(entry.aiTags));

    // Face Metadata
    if (entry.faceTags) addColumn('faceTags', JSON.stringify(entry.faceTags));

    // Processing timestamps (not part of FileRecord type, but stored in DB)
    const entryAny = entry as Record<string, unknown>;
    if (entryAny.infoProcessedAt) addColumn('infoProcessedAt', entryAny.infoProcessedAt as string);
    if (entryAny.exifProcessedAt) addColumn('exifProcessedAt', entryAny.exifProcessedAt as string);

    // Validate that names and values are in sync
    if (names.length !== values.length) {
        throw new Error(
            `Internal error in getColumnNamesAndValues: ${names.length} names but ${values.length} values. ` +
            `Names: ${names.join(', ')}`
        );
    }

    return { names, values };
}