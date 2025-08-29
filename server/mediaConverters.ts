import { Buffer } from "buffer";
import fs from "fs/promises";
import { exec, spawn } from "node:child_process";
import path from "path";
import sharp from 'sharp';
import { mediaCacheDir, rootDir } from "./config.ts";
import { createDashFiles, isDashFile } from "./dash/createDashFiles.ts";

type Dimensions = {
    height?: number;
    width?: number;
}

const dimensionsToPathString = (dimensions:Dimensions) => {
    if (dimensions.width){
        return `-${dimensions.width}w`;
    }
    if (dimensions.height){
        return `-${dimensions.height}h`;
    }
    // Return "full" for full resolution when no dimensions specified
    return "-full";
}

const webpCachePath = (relativePath:string, dimensions:Dimensions) =>{
    return path.join(mediaCacheDir, relativePath)+ dimensionsToPathString(dimensions) + ".webp"
};


type Details = {
    dimensions: {height:number, width:number};
    fileSize: number;
}

type FileHandler = {
    name:string,
    extensions?: string[];
    canHandleFile: (path:string) => boolean;
    handler: (relativePath: string, dimensions?: Dimensions) => Promise<
        | { file: Buffer; contentType: string }
        | { stream: NodeJS.ReadableStream; contentType: string }
    >;
    details?: <T extends (keyof Details)[]>(relativePath:string, desiredDetails:T) => Promise<Pick<Details,T[number]>>;
}

const imageDetails:FileHandler['details'] = async (relativePath, desiredDetails) => {
    const out = {} as Details;
    const fullPath = path.join(rootDir, relativePath);
    for (const detail of desiredDetails){
        if (detail in desiredDetails){
            continue;
        }
        switch (detail) {
            case 'dimensions':{
                const metadata = await sharp(fullPath).metadata();
                let { orientation, width, height } = metadata;

                // Swap w/h if orientation is 90 or 270 degrees
                if (orientation === 6 || orientation === 8) {
                    [width, height] = [height, width];
                }
                out.dimensions = {width:width || 0, height:height || 0};
                break;
            }
            case 'fileSize':{
                const stats = await fs.stat(fullPath);
                out.fileSize = stats.size;
                break;
            }
        }
    }
    return out;
}

export const videoExtensions = ['.mp4', '.mov', '.mkv', '.avi', '.wmv', '.flv', '.webm'];

const extValidator = (exts:string[])=> (p:string) => exts.includes(path.extname(p).toLowerCase());

export const fileHandlers = [
    {
        name: "Dash",
        canHandleFile: isDashFile,
        handler: async (relativePath:string) => {
            const fullPath = path.join(mediaCacheDir, relativePath);
            const content = await fs.readFile(fullPath);
            return { file: content, contentType: 'application/dash+xml' };
        }
    },
    {
        name: "Video",
        canHandleFile: extValidator(videoExtensions),
        handler: async (relativePath:string) => {
            const sourceFullPath = path.join(rootDir, relativePath);
            const cacheDir = path.join(mediaCacheDir, path.dirname(relativePath));
            const baseName = path.basename(relativePath, path.extname(relativePath));
            const manifestPath = path.join(cacheDir, `${baseName}.mpd`);

            // Check if DASH manifest already exists
            try {
                await fs.access(manifestPath);
                console.log('[VIDEO] Serving existing DASH manifest:', manifestPath);
                const manifestContent = await fs.readFile(manifestPath, 'utf-8');
                return { file: Buffer.from(manifestContent), contentType: 'application/dash+xml' };
            } catch {
                // Manifest doesn't exist, create DASH files
                console.log('[VIDEO] Creating DASH files for:', relativePath);
                const dashManifestPath = await createDashFiles({
                    sourceFilePath: sourceFullPath,
                    destDir: cacheDir
                });
                
                console.log('[VIDEO] DASH creation complete:', dashManifestPath);
                const manifestContent = await fs.readFile(dashManifestPath, 'utf-8');
                return { file: Buffer.from(manifestContent), contentType: 'application/dash+xml' };
            }
        }
    },
    {
        name: "High Efficiency Image",
        canHandleFile: extValidator(['.heic', '.heif']),
        handler: async (relativePath:string, dimensions?:Dimensions) => {
            const originalPath = path.join(rootDir, relativePath);
            const cachePath = webpCachePath(relativePath, dimensions || {});
            const contentType = 'image/webp';
            try{
                return {
                    file: await fs.readFile(cachePath),
                    contentType
                }
            } catch (e){
                if (e && typeof e === 'object' && "code" in e && e.code === 'ENOENT') {
                    
                    console.log(`Creating ${dimensions?.width ? dimensions.width + 'px' : 'full resolution'} WebP for HEIC file: ${relativePath}`);
                    fs.mkdir(path.dirname(cachePath), { recursive: true });
                    const magickArgs = [
                        'magick',
                        `"${originalPath}"`,
                        ...((dimensions?.width && dimensions?.width) ? ["-resize"] : []),
                        ...(dimensions?.width ? [`${dimensions.width}x`] : []),
                        ...(dimensions?.height ? [`${dimensions.height}y`] : []),
                        `"${cachePath}"`,
                    ];

                    const command = magickArgs.join(' ')
                    console.log(`Running command: ${command}`);
                    await new Promise((resolve, reject) => {
                        exec(command, (error, stdout, stderr) => {
                            if (error) {
                                reject({ code: error.code ?? 1, stdout, stderr });
                            } else {
                                resolve({ code: 0, stdout, stderr });
                            }
                        });
                    });
                    
                    return {file:await fs.readFile(cachePath), contentType};
                } 
                throw e;
            }
        },
        details: imageDetails
    },    
    {
        name: "Image",
        canHandleFile: extValidator(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff']),
        handler: async (relativePath, dimensions) => {
            const ext = path.extname(relativePath).toLowerCase();
            const fullPath = path.join(rootDir, relativePath);
            if (!dimensions?.width){
                const file = await fs.readFile(fullPath);
                // Return JPG files as JPG, others as their original format
                const contentType = ext === '.jpeg' ? 'image/jpeg' : 
                                   ext === '.jpg' ? 'image/jpeg' : 
                                   `image/${ext.substring(1)}`;
                return {file, contentType};
            }
            
            const thumbnailPath = webpCachePath(relativePath, dimensions);
            try{
                const file = await fs.readFile(thumbnailPath);
                return {file, contentType: 'image/webp'};
            } catch (e) {
                if (e && typeof e === 'object' && "code" in e && e.code === 'ENOENT') {
                    console.log(`Creating ${dimensions.width} thumbnail for ${ext} file: ${relativePath}`);
                    const file = await fs.readFile(fullPath);
                    const thumbnail = await sharp(file)
                        .rotate()
                        .resize({ width: dimensions.width })
                        .toFormat('webp')
                        .toBuffer();
                    fs.mkdir(path.dirname(thumbnailPath), { recursive: true }).then(async () => {
                        await fs.writeFile(thumbnailPath, thumbnail);
                    });
                    return {file:thumbnail, contentType: 'image/webp'};
                } 
                throw e;
            };
        },
        details: imageDetails
    }
] as const satisfies FileHandler[]