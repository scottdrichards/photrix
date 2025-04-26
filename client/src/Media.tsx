type Params = {
    path: string,
    style?: React.CSSProperties,
    width?: number,
}

export const Media:React.FC<Params> = (params)=>{
    const {path, style, width} = params;

    const url = new URL(encodeURIComponent(path), `http://localhost:9615/media/`);
    if (width){
        url.searchParams.set('width', width.toString());
    }

    const renderers = [
        [['jpg','png','jpeg','gif'], () =><img
                style={{ objectFit: 'contain', ...style }}
                src={url.toString()}
                loading="lazy" 
            />
        ],
        [['mp4','mov','avi'],() => 
            <></>
        ],
    ] as const;

    const ext = path.split('.').at(-1) as string;
    
    const Renderer = renderers.find(([exts])=>(exts as any as string[]).includes(ext.toLocaleLowerCase()))?.[1];

    return Renderer?<Renderer/> : <div>Unsupported file type</div>;
}