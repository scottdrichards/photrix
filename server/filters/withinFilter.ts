import path from "node:path";
import type { Folder, MediaFile } from "../database";
import type { Filter } from "./filterType";

export type FileType = 'folder' | 'file';

type FilterParams<T extends boolean> = {
    within: Folder;
    recursive?: boolean;
    includeFolders?: T;
}

export const withinFilter = <P extends FilterParams<boolean>>(params: P):Filter<P['includeFolders'] extends true?Folder|MediaFile:MediaFile > => {
    const { within, recursive, includeFolders } = params;
    const withinPath = path.join(within.parentPath, within.name);

    const validator = (item: MediaFile | Folder):boolean => {
        if (!recursive && item.parentPath !== withinPath) {
            return false;
        }
        const relativePath = path.relative(withinPath, item.parentPath);
        if (relativePath.startsWith("..")) {
            return false;
        }
        if (item.type === "folder" && !includeFolders) {
            return false;
        }
        return true;
    };

    const generatorFn = function* getFolderItems(): Generator<P['includeFolders'] extends true?Folder|MediaFile:MediaFile> {
        const toProcess: Array<Folder> = [within];
        while (toProcess.length > 0) {
            const current = toProcess.pop();
            for (const child of current!.children) {
                if (child.type === "folder" && recursive) {
                    toProcess.push(child);
                }
                if (child.type === "file"){
                    yield child;
                }
                if (includeFolders && child.type === "folder") {
                    
                    yield child as P['includeFolders'] extends true?Folder:never;
                }
            }
        }
    };
    const generator = generatorFn();

    if (!recursive){
        return {
            set: new Set(generator)
        };
    }
    return {
        generator,
        validator,
    }
}