import { DatabaseFileEntry } from "./fileRecord.type.ts";
import { FileRecord } from "./indexDatabase.type.ts";

/**
 * Converts a database row to a FileRecord by parsing JSON fields and reconstructing nested objects
 */
export const rowToFileRecord = (row: Record<string, string|number>, wantedFields: Array<keyof FileRecord>|'all'='all'): FileRecord => {
    const date = (v:string|number)=>new Date(v);
    const json = (v:string)=>JSON.parse(v);

    if (!row.relativePath) {
        throw new Error("rowToFileRecord: row is missing relativePath");
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
        ["exifProcessedAt", date],
    ] as const;

    const basicObject = fieldConversions.map(entry=>{
        const [field, conversionFn] = typeof entry === 'string'? [entry]: entry;
        const rowValue = row[field];
        return {field, rowValue, conversionFn}
    }).filter(({field, rowValue})=>{
        if (wantedFields === 'all'){
            return true;
        }
        if (!wantedFields.includes(field)){
            return false;
        }
        // 🤖 I want this to represent the state of the DB - Let's say undefined means "no entry"
        // and "NULL" means "we know there is no data". So if we haven't checked for a file's
        // location, locationLatitude would be `undefined` whereas if we checked and the file has
        // no location data, locationLatitude would be `null` 
        if (rowValue=== undefined){
            return false;
        }
        return true;
    }).reduce((acc,{field, rowValue, conversionFn})=>{
        if (!conversionFn){
            return {...acc, [field]: rowValue}
        }
        return {...acc, [field]:conversionFn(rowValue as string)}
    },{} as Partial<FileRecord>);

    /////////////////
    // Now add row values that have different keys than DB entries.
    const {dimensionsWidth, dimensionsHeight, locationLatitude, locationLongitude} = row;

    const dimensions = (()=>{
        if (dimensionsWidth !== null && dimensionsHeight !== null) {
            return { width: dimensionsWidth, height: dimensionsHeight };
        }
    })()

    const location = (()=>{
        if (locationLatitude && locationLongitude){
            return {latitude:locationLatitude, longitude: locationLongitude};
        }
    })()

    return {
        relativePath: row.relativePath as string,
        mimeType: row.mimeType as string | undefined,
        ...basicObject,
        ...dimensions,
        ...location,
    } as FileRecord;
}

/**
 * Converts a FileRecord to column names and values for SQL insertion
 */
export const fileRecordToColumnNamesAndValues = (entry: Partial<DatabaseFileEntry>): { names: string[]; values: (string|number)[] } => {
    const names: string[] = [];
    const values: (string|number)[] = [];

    const addColumn = (name: string, value: string|number|undefined|null) => {
        if (value === undefined || value === null){
            return;
        }
        names.push(name);
        values.push(value);
    };

    // Always include relativePath and mimeType
    if (entry.relativePath) addColumn('relativePath', entry.relativePath);
    if (entry.mimeType) addColumn('mimeType', entry.mimeType);

    // File Info
    if (entry.sizeInBytes) addColumn('sizeInBytes', entry.sizeInBytes);
    if (entry.created) addColumn('created', entry.created instanceof Date ? entry.created.getTime() : entry.created);
    if (entry.modified) addColumn('modified', entry.modified instanceof Date ? entry.modified.getTime() : entry.modified);

    // EXIF Metadata
    if (entry.dateTaken) addColumn('dateTaken', entry.dateTaken instanceof Date ? entry.dateTaken.getTime() : entry.dateTaken);
    if (entry.dimensions) {
        addColumn('dimensionsWidth', entry.dimensions.width);
        addColumn('dimensionsHeight', entry.dimensions.height);
    }
    if (entry.location) {
        addColumn('locationLatitude', entry.location.latitude);
        addColumn('locationLongitude', entry.location.longitude);
    }
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

    // Processing status
    if (entry.exifProcessedAt) addColumn('exifProcessedAt', entry.exifProcessedAt);
    if (entry.thumbnailsProcessedAt) addColumn('thumbnailsProcessedAt', entry.thumbnailsProcessedAt);

    // Validate that names and values are in sync
    if (names.length !== values.length) {
        throw new Error(
            `Internal error in getColumnNamesAndValues: ${names.length} names but ${values.length} values. ` +
            `Names: ${names.join(', ')}`
        );
    }

    return { names, values };
}