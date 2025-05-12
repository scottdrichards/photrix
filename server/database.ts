import fs from "fs/promises";
import path from "path";
import { rootDir } from "./config.ts";

export type File = {
    type: 'file';
    name: string;
}

export type Folder = {
    type: 'folder';
    name: string;
    children: (Folder|File)[] | undefined;
}

export const getContentsOfDirectory = async (dir: string): Promise<Folder['children']> => {const contentsResults = await fs.readdir(dir, { withFileTypes: true });
return contentsResults.map((file) => {
        const fullPath = path.join(dir, file.name);
        if (file.isDirectory()) {
            console.log('Directory:', fullPath);
            return {
                type: 'folder',
                name: file.name,
                children: undefined
            } as Folder;
        } else {
            const filePath = path.relative(rootDir, fullPath) + '\n';
            return {type:'file',name:filePath};
        }
    })};

export const createDatabase = async (dir:string) => {
    const contents = await getContentsOfDirectory(dir);
    if (!contents) {
        throw new Error(`Failed to read directory: ${dir}`);
    }
    return Promise.all(contents.map(async (item):Promise<File|Folder> => {
        if (item.type === 'file') {
            return item;
        }
        return {
            ...item,
            children: item.children || await createDatabase(path.join(dir, item.name))
        }
    }
    ));
}

export const database = {
    setRootAndScan: async (dir: string) => {
        const walk = async (folder:Folder, dir: string): Promise<void> => {
            const list = await fs.readdir(dir, { withFileTypes: true });
            for (const file of list) {
                const fullPath = path.join(dir, file.name);
                if (file.isDirectory()) {
                    console.log('Directory:', fullPath);
                    const newFolder = {
                        name: file.name,
                        children: []
                    } as Folder;
                    folder.children.push(newFolder);
                    await walk(newFolder, fullPath);
                } else {
                    const filePath = path.relative(rootDir, fullPath) + '\n';
                    folder.children.push({name:filePath});
                }
            }
        };
        database.root = {
            name: dir,
            children: []
        } as Folder;
        this.root = await walk(database.root, dir);
    },
    root: {
        name: rootDir,
        children: []
    } as Folder,
    getPath: (path: string) => path.split('/').reduce((acc, part) => {
        const folder = acc.children.find(child => child.name === part) as Folder;
        if (!folder) {
            throw new Error(`Folder ${part} not found`);
        }
        return folder;
    }, database.root),
    getFiles: (path:string, includeSubfolders: boolean) => {
        const folder = database.getPath(path);
        const files: File[] = [];
        const walk = (folder: Folder) => {
            for (const child of folder.children) {
                if ('children' in child) {
                    if (includeSubfolders) {
                        walk(child);
                    }
                } else {
                    files.push(child);
                }
            }
        };
        walk(folder);
        return files;
    },
}

console.log('Building database...');
await walk(database.root, rootDir);
console.log('Database built');
