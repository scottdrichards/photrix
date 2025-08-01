import { ExifTool } from "exiftool-vendored";
import fs from "node:fs/promises";
import path from "node:path";
import { heapStats } from "bun:jsc";

import { rootDir } from "./config.ts";
import { Dirent } from "node:fs";
import { SortedListIndex } from "./utils/SortedListIndex.ts";
import { type FileType, withinFilter } from "./filters/withinFilter.ts";
import { dateRangeToNumberRange } from "./utils/dateRangeToNumberRange.ts";
import { makeIndexes } from "./indexUtils.ts";
import { indexFilters } from "./filters/indexFilter.ts";
import { resolveFilters } from "./filters/resolveFilters.ts";

const tagsOfInterest = [
    // "DateTimeOriginal",
    "Rating",
    "Make",
    "Model",
    "LensModel",
    "FocalLength",
    "Aperture",
    "ShutterSpeed",
    "ISO",
    "HierarchicalSubject",
    "ImageWidth",
    "ImageHeight",
    "Orientation"
] as const satisfies Array<keyof Partial<Tags>>;

const maxProcs = 3;
const exiftool = new ExifTool({
    taskTimeoutMillis: 5000,
    maxProcs,
    minDelayBetweenSpawnMillis: 500,
});

type Tags = Awaited<ReturnType<ExifTool["read"]>>;

type FilysystemItem = Pick<Dirent, "name" | "parentPath">;

export type Folder = FilysystemItem & {
    type: "folder";
    children: Array<Folder | MediaFile | MediaFile>;
};
export type MediaFile = FilysystemItem & { type: "file"; tags?: Pick<Tags, typeof tagsOfInterest[number]> };

const indexes = makeIndexes<MediaFile>();

let currentItem:MediaFile|undefined = undefined;
const processFileWithExifTool = async (file: MediaFile): Promise<void> => {
    currentItem = file;
    const tags = await exiftool.read(path.join(file.parentPath, file.name));
    // We can't keep all of the tag data (e.g., thumbnails) in memory, so we only keep the tags of interest.
    file.tags = Object.fromEntries(
        tagsOfInterest
            .map(tagName => [tagName, tags[tagName]])
            .filter(([, value]) => value !== undefined)
    );

    const dateFromExifDate = (
        date: string | number | { toDate: () => Date },
    ): Date => {
        if (typeof date === "object" && "toDate" in date) {
            return date.toDate();
        }
        return new Date(date);
    };
    if (tags.DateTimeOriginal) {
        const epochMillis = dateFromExifDate(tags.DateTimeOriginal).getTime();
        indexes.dateTaken.add(epochMillis, file);
    }

    ([
        [tags.Rating, indexes.Rating],
        [tags.Make, indexes.Make],
        [tags.Model, indexes.Model],
        [tags.LensModel, indexes.LensModel],
        [tags.FocalLength, indexes.FocalLength],
        [tags.Aperture, indexes.Aperture],
        [tags.ShutterSpeed, indexes.ShutterSpeed],
        [tags.ISO, indexes.ISO],
        [tags.HierarchicalSubject?.at(-1), indexes.subject],
    ] as const).forEach(([value, index]) => {
        if (!value) {
            return;
        }
        const key = `${value}`.trim().toLocaleLowerCase();
        let fileListAtKey = index.get(key);
        if (!fileListAtKey) {
            fileListAtKey = new Set();
            index.set(key, fileListAtKey);
        }
        fileListAtKey.add(file);
    });
};

type ExifProcessItem = {
    file: MediaFile;
    onfinish: (file: MediaFile) => void;
};

const exifQueue: Array<ExifProcessItem> = [];
const exifCurrentlyProcessing: Array<ExifProcessItem> = [];

let processed = 0;
let toProcess = 0;
const processNextInQueue = async (): Promise<void> => {
    const item = exifQueue.shift();
    if (!item) {
        return;
    }
    exifCurrentlyProcessing.push(item);
    const { onfinish, file } = item;
    try {
        await processFileWithExifTool(file);
        onfinish(file as Required<MediaFile>);
    } catch (error) {
        console.error(`Error processing file ${file.name}:`, error);
    } finally {
        exifCurrentlyProcessing.splice(
            exifCurrentlyProcessing.indexOf(item),
            1,
        );
        processNextInQueue();
    }
    processed++;
};

let lastProcessed:number|undefined = undefined;
setInterval(() => {
    const thisProcessed = processed - (lastProcessed || 0);

    const heapMB = (heapStats().heapSize / (1024 * 1024)).toFixed(2);
    console.log(
        `${processed} processed. Rate: ${thisProcessed} files per second. Last processed: ${currentItem?.parentPath}. Heap size: ${heapMB} MB.`,
    );
    lastProcessed = processed;
}, lastProcessed === 0 ? 60_000:2_000);

const addToQueue = (processItem: ExifProcessItem): void => {
    toProcess++;
    exifQueue.push(processItem);
    if (exifCurrentlyProcessing.length < maxProcs * 2) {
        processNextInQueue();
    }
};

export const root: Folder = {
    type: "folder",
    name: "",
    parentPath: rootDir,
    children: [],
};

export const scanFolder = async (parentFolder: Folder): Promise<void> => {
    const parentPath = path.join(parentFolder.parentPath, parentFolder.name);
    const entries = await fs.readdir(parentPath, { withFileTypes: true });
    parentFolder.children = [];
    for (const entry of entries) {
        if (entry.isDirectory()) {
            const folder = {
                type: "folder" as const,
                ...entry,
                children: [],
            };
            parentFolder.children.push(folder);
            await scanFolder(folder);
        } else {
            const file: MediaFile = {
                type: "file" as const,
                name: entry.name,
                parentPath,
            };
            parentFolder.children.push(file);
            addToQueue({
                file,
                onfinish: (MediaFile) => {
                    parentFolder.children.splice(
                        parentFolder.children.indexOf(file),
                        1,
                        MediaFile,
                    );
                },
            });
        }
    }
};



/**
 * Traverses the folder structure starting from the base folder to find item
 * @param base 
 * @param relativePath from base
 */
export const getItem = (
    base: Folder = root,
    relativePath: string,
): MediaFile | Folder => {
    const parts = relativePath.replaceAll("/", path.sep).split(path.sep).filter(
        Boolean,
    );
    let current: Folder | MediaFile = base;
    for (const part of parts) {
        if (current.type !== "folder") {
            throw new Error(`Cannot navigate into a file: ${current.name}`);
        }
        const next: Folder | MediaFile | undefined = current.children.find(
            (child) => child.name === part
        );
        if (!next) {
            throw new Error(`Item not found: ${part}`);
        }
        current = next;
    }
    return current;
};

type FilterSpecial = {
    dateTaken: { from?: Date; to?: Date };
};

type FileFilters = Partial<Omit<Record<keyof typeof indexes, string[]>, keyof FilterSpecial>
    & FilterSpecial>;

type Options =(FileFilters & {
    includeFolders?: boolean;
}) & {
    within: Folder;
    recursive: boolean;
};


export const search = (filter: Options): IterableIterator<MediaFile| Folder>  => {
    const {
        within,
        recursive,
        ...fileIndexFilterParams
    } = filter;

    const noFileFilters = !Object.values(fileIndexFilterParams).some(v=>!!v)
    const includeFolders = noFileFilters && !!within;

    const {dateTaken, ...standardFileIndexFilterParams} = fileIndexFilterParams
    const indexSearch = indexFilters(indexes, {...standardFileIndexFilterParams, dateTaken: dateTaken && dateRangeToNumberRange(dateTaken)});

    const filters = [...indexSearch, within && withinFilter({
        within,
        recursive,
        includeFolders,
    })].filter(v=>!!v);

    return resolveFilters(filters);
}
