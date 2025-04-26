import { useEffect, useState } from "react";
import { Media } from "./Media";

const minSize = 100;
const maxSize = 1000;

type Params = {
    directoryPath: string|undefined,
    includeSubfolders?: boolean,
    style?:React.CSSProperties,
}

export const ThumbnailViewer:React.FC<Params> = (params)=>{
    const {directoryPath, includeSubfolders, style} = params;
    const [thumbnails, setThumbnails] = useState<{path:string,type:'file'|'directory', details?:{dimensions:{width:number, height:number}}}[]>([]);
    const [loading, setLoading] = useState(false);
    const [size, setSize] = useState(.2*(maxSize-minSize)+minSize);

    useEffect(()=>{
        if (!directoryPath) return;
        let cancelled = false;
        setLoading(true);
        // setThumbnails([]);
        (async ()=>{
            const url = new URL(`/media/${directoryPath}`, "http://localhost:9615");
            url.searchParams.set("details", JSON.stringify(['dimensions']));
            if (includeSubfolders){
                url.searchParams.set('includeSubfolders', 'true');
            }
            const response = await fetch(url.toString());
            if (cancelled) return;
            const data = await response.json();
            setThumbnails(data);
            setLoading(false);
        })();
        return () => {
            cancelled = true;
        };
    },[directoryPath, includeSubfolders]);

    return (
        <div style={{...style, display:'flex', flexWrap:'wrap', alignContent:'flex-start', gap:"10px", padding: '10px', boxSizing: "border-box","--size":size} as React.CSSProperties}>
            {thumbnails.map((thumbnail) =>{
                const dimensions = thumbnail.details?.dimensions;
                const ratio = (dimensions?.width ||1 )/ (dimensions?.height || 1);
            return <div  key={thumbnail.path} style={{
                minHeight: size,
                minWidth: `calc(min(100%, ${size*ratio}px))`,
                flexBasis:  size*ratio,
                flex: ratio,
            }}>
                <Media path={thumbnail.path} width={100} style={{width:"100%", height:'100%', objectFit:'cover' }} />
                </div>})}
            {loading && <div>Loading...</div>}
            <input type="range" min={minSize} max={maxSize} value={size} onChange={(e)=>{
                const v = parseInt(e.currentTarget.value);
                Promise.resolve().then(()=>setSize(v))}} style={{position:"absolute", bottom:"50px"}}/>
        </div>
    )
}
    

