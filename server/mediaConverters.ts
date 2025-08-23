import { Buffer } from "buffer";
import fs from "fs/promises";
import { exec } from "node:child_process";
import path from "path";
import sharp from 'sharp';
import { mediaCacheDir, rootDir } from "./config.ts";

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

const getCodec = async (fullPath:string) => {
    // use ffmpeg to determine if files is h.265
    const ffprobe = await new Promise((resolve, reject) => {
        exec(`ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "${fullPath}"`, (error, stdout, stderr) => {   
            if (error) {
                console.error(`Error converting file: ${error.message}`);
                reject(error);
            } else if (stderr) {
                console.error(`Error converting file: ${stderr}`);
                reject(new Error(stderr));
            } else {
                resolve(stdout.trim());
            }
        });
    });
    return ffprobe
}


const convertToH264 = async (relativePath:string):Promise<string> => {
    const fullPath = path.join(rootDir, relativePath);
    const cachePath = path.join(mediaCacheDir, relativePath);
    if (await fs.stat(cachePath).catch(e=>e.code !== 'ENOENT')){
        return cachePath;
    }
    return new Promise((resolve, reject) => {
        exec(`ffmpeg -i "${fullPath}" -c:v libx264 -crf 23 -preset medium -c:a aac -b:a 192k "${cachePath}"`, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error converting file: ${error.message}`);
                reject(error);
            } else if (stderr) {
                console.error(`Error converting file: ${stderr}`);
                reject(new Error(stderr));
            } else {
                console.log(`File converted successfully: ${cachePath}`);
                resolve(cachePath);
            }
        });
    });
};

type Details = {
    dimensions: {height:number, width:number};
    fileSize: number;
}

type FileHandler = {
    extensions: string[];
    handler: (relativePath: string, dimensions?: Dimensions) => Promise<{file:Buffer, contentType:string}>;
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

export const fileHandlers = [
    {
        extensions: ['.mp4', '.mov', '.mkv', '.avi', '.wmv', '.flv'],
        handler: async (relativePath:string) => {
            const mimeTypeExtensions = {
                'video/mp4':['.mp4'],
                'video/quicktime':['.mov'],
                'video/x-matroska':['.mkv'],
                'video/x-msvideo':['.avi'],
                'video/x-ms-wmv':['.wmv'],
                'video/x-flv':['.flv'],
                'video/webm':['.webm'],
            };
            const fullPath = path.join(rootDir, relativePath);
            const ext = path.extname(relativePath).toLowerCase();
            
            if (ext === '.mp4' && await getCodec(fullPath) === 'hevc'){
                return {
                    file: await fs.readFile(await convertToH264(relativePath)),
                    contentType: 'video/mp4'
                }
            }

            return {
                file: await fs.readFile(fullPath),
                contentType: Object.entries(mimeTypeExtensions).find(([_,v])=>v.includes(ext))?.[0] ?? 'application/octet-stream'
            }
        }
    },
    {
        extensions: ['.heic', '.heif'],
        handler: async (relativePath:string, dimensions?:Dimensions) => {
            const originalPath = path.join(rootDir, relativePath);
            // When no width specified, convert to full resolution WebP
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
        extensions: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff'],
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