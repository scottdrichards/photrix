import fs from "fs/promises";
import path from "path";

export type Item = {
    name:string,
    type: string,
}

export type File = Item & {
    type: 'file';
}

type Children = {
    value: (Folder|File)[]|undefined;
    subscribers?: ((value?: unknown) => void)[];
}

export type Folder = Item & {
    type: 'folder';
    children: Children | undefined;
}


type GetMultipleOptions = {
    search?: string;
    type?: 'file' | 'folder' | {extensions: string[]};
    recurse?: boolean;
    within?: string | {
        /* Folder - for caching/lookup purposes */
        folder: Folder;
        /* Relative path to the folder, relative to the root of the database 
            It incudes the folder name itself */
        relativePath: string;
    };
};

export class Database {
    private root: Folder;
    private path: string;
    constructor(path: string) {
        this.path = path;
        this.root = {
            type: 'folder',
            name: "",
            children: undefined,
        };
    }

    
    private  getChildren = async (relativePath: string): Promise<(Folder|File)[]> =>
        fs.readdir(path.join(this.path,relativePath), { withFileTypes: true })
            .then<(File|Folder)[]>((results) => 
                results.map((entry) => {
                    if (entry.isDirectory()) {
                        return {
                            type: 'folder',
                            name: entry.name,
                            children: undefined,
                        };
                    }
                    return {type:'file',name:entry.name};
    }))

    /**
     * @param pathToElement relative to root
     * @returns a reference to a file or folder in the database.
     */
    public async getSingle(pathToElement: string): Promise<Folder|File> {
        const pathParts = pathToElement.split(path.sep).filter(part => part !== '');;
        let current: Folder|File = this.root;
        let currentPath = "";
        for (const pathPart of pathParts) {
            currentPath = path.join(currentPath, current.name);
            if (current.type === 'file') {
                throw new Error(`Cannot navigate into file (should be a folder) ${current.name}`);
            }

            if (current.children === undefined) {
                current.children = {
                    value:undefined, subscribers: []
                };
                const children = await this.getChildren(currentPath);
                const subscribers = current.children.subscribers;
                current.children = {value: children};
                subscribers?.forEach(fn => fn());
            }

            const subscribers = current.children.subscribers;
            if (current.children.value === undefined && subscribers) {
                await new Promise(resolve => {
                    subscribers.push(resolve);
                });
            }

            if (!current.children.value) {
                throw new Error(`Fodler children should have value at this point`);
            }

            const next:File|Folder|undefined = current.children.value.find(child => child.name === pathPart);
            if (!next) {
                throw new Error(`Item ${pathPart} not found in path ${pathToElement}`);
            }
            current = next;
        }
        return current;
    }

    /**
     * 
     * @param options 
     * @returns an async generator that yields items and relative paths to the "within" location.
     */
    public async *getMultiple(options:GetMultipleOptions): AsyncGenerator<{item:Folder|File, relativePath:string}> {
        const base = options.within
            ? typeof options.within === 'string' ?
                await this.getSingle(options.within) :
                options.within.folder
            : this.root;

        if (base.type === 'file') {
            throw new Error(`Cannot search within a file: ${base.name}`);
        }
        
        // Folder path includes the Folder itself
        const toSearch:{item:Folder,relativePath:string}[] = [{
            item: base,
            relativePath: options.within?
                typeof options.within === 'string' ?
                    options.within
                    : options.within.relativePath
                : '',
        }];

        while (toSearch.length) {
            const {item: current, relativePath} = toSearch.shift()!;
            // Nobody has started looking for children yet, so we can start
            if (current.children === undefined) {
                const value = await this.getChildren(relativePath);
                current.children = {
                    value
                };
                if (current.children.subscribers) {
                    current.children.subscribers.forEach(fn => fn());
                    delete current.children.subscribers;
                }
            }
            // Someone has started looking for children, but it isn't us, so we wait for them to finish
            if (current.children.value === undefined) {
                // Typescript has trouble with the typing of current within the promise, this copy helps
                // it understand a bit
                const currentCopy = current;
                await new Promise(resolve => {
                    if (currentCopy.children!.subscribers === undefined) {
                        currentCopy.children!.subscribers = [];
                    }
                    currentCopy.children!.subscribers.push(resolve);
                });
            }

            for (const child of current.children.value!) {
                if (options.type) {
                    if (typeof options.type === 'object' && 'extensions' in options.type) {
                        if (child.type === 'file' && !options.type.extensions.includes(path.extname(child.name))) {
                            continue;
                        }
                    } else if (child.type !== options.type) {
                        continue;
                    }
                }
                if (options.search && !child.name.toLowerCase().includes(options.search.toLowerCase())) {
                    continue;
                }
                const next = {
                    item: child,
                    relativePath: path.join(relativePath, child.name),
                };
                yield next;
                if (next.item.type === 'folder' && options.recurse) {
                    toSearch.push(next as {item:Folder, relativePath:string});
                }
            }
        }
    }
}