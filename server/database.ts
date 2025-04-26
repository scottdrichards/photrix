import fs from "fs/promises";
import path from "path";
import { rootDir } from "./config.ts";

export type File = {
    name: string;
}

export type Folder = {
    name: string;
    children: (Folder|File)[];
}

export const database = {
    root: {
        name: rootDir,
        children: []
    } as Folder,
}

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

console.log('Building database...');
// await walk(database.root, rootDir);
console.log('Database built');
