import { useEffect, useState } from "react";
import { Filters } from "./data/filters";
import { invoke } from "@tauri-apps/api/core";
import { join, pictureDir} from '@tauri-apps/api/path';
import { convertFileSrc } from '@tauri-apps/api/core';
const picDir = await pictureDir();

type Params = {
    filters:Filters
}

export const Gallery = (params: Params) => {
    const {filters: filter} = params;

    const [imgList, setImgList] = useState<string[]>([]);
    useEffect(() => {
        (async ()=>{
            const results = await invoke<{name:string}[]>("fetch_directory_contents",{
                directory: filter.folder,
                includeFiles:true,
                includeDirs:false
            })
            const paths = await Promise.all(results.map(async (result)=>{
                    const path = await join(picDir, filter.folder??"", result.name);
                    return convertFileSrc(path);
            }));
            setImgList(paths);
        })()
    }, [filter.folder]);

    return (
        <div>
            Gallery
            <div>{filter.folder}</div>
            <div>{imgList.map(img=><img src={img} alt={img} key={img}/>)}</div>
        </div>
    )
}