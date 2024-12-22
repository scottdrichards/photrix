import fs, { WatchEventType } from 'fs';
import { FileChangeInfo, readdir, watch } from 'fs/promises';

const __ROOT__ = "C:/Users/Scott/Downloads"

type Rating = "1" | "2" | "3" | "4" | "5";
type RatingFilterParams = Rating[];

type DatabaseItem = {
    hash: string,
    fullPath: string,
    rating?: Rating,
    tags?: string[],
    description?: string,
    date?: string,
    location?: string,
}

type FileSystem = Record<string, (DatabaseItem['hash']|FileSystem)[]>;

type FilterParams = {
    rating?: RatingFilterParams,
    path?: string,
    tags?: string[],
    description?: string,
    date?: string,
}

type Database = {
    items: Map<DatabaseItem['fullPath'], DatabaseItem>,
    indices: {
        rating: Record<Rating, DatabaseItem['hash'][]>,
        tags: Record<string, DatabaseItem['hash'][]>,
        fileSystem: FileSystem,
    }
}

const createDatabase = ():Database=>({
    items: new Map(),
    indices:{
        rating: {
            "1": [],
            "2": [],
            "3": [],
            "4": [],
            "5": [],
        },
        tags: {},
        fileSystem: {},
    },
});

const filter = (db:Database, {rating, path, tags, description, date}:FilterParams):DatabaseItem[]=>
    Array.from(db.items.values()).filter(item=>
        rating?.includes(item.rating as Rating) ??
        path?.includes(item.fullPath) ??
        tags?.every(tag=>item.tags?.includes(tag)) ??
        description?.includes(item.description as string) ??
        date?.includes(item.date as string) ??
        true);

const watchEventHandlers = {
    change: (db, event)=>{
        console.log("change", event);
    },
    rename: (db, event)=>{
        console.log("rename", event);
    },
} as const satisfies Record<WatchEventType, (db:Database, event:FileChangeInfo<string>)=>void>;


export const server = ()=>{
    const db = createDatabase();

    const watcher = async function*(){
        const files = (await readdir(__ROOT__, {withFileTypes: true})).filter(file=>file.isFile());
        
    }

    // First run
    fs.readdir(__ROOT__, {withFileTypes: true}, (err, files)=>{
        if (err) throw err;
        files.forEach(file=>{
            if (file.isFile()){
                db.items.set(file.name, {
                    hash: file.name,
                    fullPath: file.name,
                });
            }
        });
    });

    const ac = new AbortController();
    const { signal } = ac;

    (async () => {
        try {
          const watcher = watch(__ROOT__, { signal, recursive: true });
          for await (const event of watcher){
            watchEventHandlers[event.eventType](db, event);
          }
        } catch (err) {
          if (typeof err === 'object' && err && 'name' in err && err.name === 'AbortError')
            return;
          throw err;
        }
      })();

      const onAbort = ac.abort;
}