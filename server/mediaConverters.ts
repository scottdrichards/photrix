import { Buffer } from "buffer";
import fs from "fs/promises";
import heicConvert from 'heic-convert';
import path from "path";
import sharp from 'sharp';
import { cacheDir, rootDir } from "./config.ts";
import {exec} from "node:child_process";

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
    return "";
}

const webpCachePath = (relativePath:string, dimensions:Dimensions) =>{
    return path.join(cacheDir, relativePath)+ dimensionsToPathString(dimensions) + ".webp"
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
    const cachePath = path.join(cacheDir, relativePath);
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
            case 'dimensions':
                const {width, height} = await sharp(fullPath).metadata();
                out.dimensions = {width:width || 0, height:height || 0};
                break;
            case 'fileSize':
                const stats = await fs.stat(fullPath);
                out.fileSize = stats.size;
                break;
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
            const cachePath = webpCachePath(relativePath, dimensions || {height: 1024});
            const contentType = 'image/webp';
            try{
                return {
                    file: await fs.readFile(cachePath),
                    contentType
                }
            } catch (e){
                if (e && typeof e === 'object' && "code" in e && e.code === 'ENOENT') {
                    // File not found, create thumbnail using sharp
                    const fileBuffer = await fs.readFile(originalPath);
                    const jpegBuffer = await heicConvert({
                        buffer: fileBuffer as unknown as ArrayBufferLike, // the HEIC file buffer
                        format: 'JPEG', // output format
                        quality: 1 // the quality of the output file
                    });
                    const webpSharp = sharp(jpegBuffer)
                        .toFormat('webp');

                    const width = dimensions?.width;
                    const height = dimensions?.height;
                    const resizeBy = width ? { width } : height ? { height } : undefined;
                    const webpBuffer =await( resizeBy ? webpSharp.resize(resizeBy):webpSharp).toBuffer();
                    await fs.mkdir(path.dirname(cachePath), { recursive: true });
                    await fs.writeFile(cachePath, webpBuffer);
                    return {file:webpBuffer, contentType};
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
                return {file, contentType: `image/${ext.substring(1)}`};
            }
            
            const thumbnailPath = webpCachePath(relativePath, dimensions);
            try{
                const file = await fs.readFile(thumbnailPath);
                return {file, contentType: 'image/webp'};
            } catch (e) {
                if (e && typeof e === 'object' && "code" in e && e.code === 'ENOENT') {
                    // File not found, create thumbnail using sharp
                    const file = await fs.readFile(fullPath);
                    const thumbnail = await sharp(file)
                        .resize({ width:dimensions.width })
                        .toFormat('webp')
                        .toBuffer();
                    await fs.mkdir(path.dirname(thumbnailPath), { recursive: true });
                    await fs.writeFile(thumbnailPath, thumbnail);
                    return {file:thumbnail, contentType: 'image/webp'};
                } 
                throw e;
            };
        },
        details: imageDetails
    }
] as const satisfies FileHandler[]