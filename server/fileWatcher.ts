import { WatchEventType } from "fs";
import { FileChangeInfo, readdir, watch } from "fs/promises";

const fileWatcher = (dir:string)=>{
    const pathsToProcess:AsyncGenerator<FileChangeInfo<string>> = (async function*(){
        // First run
        const files = await readdir(dir, {withFileTypes:true});
        for (const file of files){
            if (file.isDirectory()){
                // yield* file.name);
            } else {
                yield {filename: file.name, eventType:'rename' as WatchEventType};
            }
        }

        // Now watch for changes
        try {
            const watcher = watch(dir, {recursive:true});
            for await (const event of watcher){
                yield event;
            }
        } catch (err) {
            if (typeof err === 'object' && err && 'name' in err && err.name === 'AbortError')
                return;
            throw err;
        }
    })();

    (async ()=>{
        for await (const path of pathsToProcess){
            
        }
    })();

    
    (async ()=>{
        for await (const path of metaDataToRead){
            
        }
    })();

    (async ()=>{
        for await (const path of filesToRead){
            
        }
    })();


}