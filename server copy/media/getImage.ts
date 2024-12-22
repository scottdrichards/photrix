import { readFile } from "fs/promises";
import convert from "heic-convert";
import path from "path";
import sharp from "sharp";
import { Dimensions, getNearestSize, getSizeLabel, isThumbnail } from "./dimensionDefintions";
import { mkdir } from "fs/promises";
import { hasProperty } from "../../utils/guards";

type Config = {
    rootDir: string,
}

type ThumbnailConfig = Dimensions & {
    thumbnailDir: string, // it will then have 'large', 'medium', 'small' etc. directories
}

type AllOrNothing<T extends Record<string, any>> = T | Partial<Record<keyof T, never>>;


type ImageOptions = AllOrNothing<ThumbnailConfig> & Config;

type ImageHandler = <T>(file:Buffer|ArrayBuffer, options:ImageOptions)=>Promise<Buffer|ArrayBuffer>;


const sharpHandler:ImageHandler = async (f, opts) => {
    const sharpFile = sharp(f);
    const readyFile = ('height' in opts && 'width' in opts && opts.height && opts.width)?
        // resize if we have dimensions
        sharpFile.resize(opts.width, opts.height, {fit:'outside'}) :
        sharpFile;
    return readyFile.jpeg().toBuffer();
}

const heicHandler:ImageHandler = async (f, opts)=>
    convert({buffer:f,format:'JPEG',quality:1})
    .then(file=>sharpHandler(file, opts));


const handleDefinitions = [
    [heicHandler, ['heic', 'heif']],
    [sharpHandler, ['jpeg','jpg', 'png', 'webp', 'gif', 'avif', 'tiff', 'svg']],
] as const satisfies [ImageHandler, string[]][];

// make it so that each extension is a key for a handler for easy lookups
const handleDefinitionsExpanded = handleDefinitions.flatMap(([handler, exts])=>
    exts.map(ext=>[ext, handler] as const));

const handlers = new Map(handleDefinitionsExpanded);

export const supportedImageExtensions = handlers.keys();

export const getImage = async <T>(relativePath: string, options: ImageOptions): Promise<Buffer|ArrayBuffer> =>{
    const image = await readFile(path.join(options.rootDir, relativePath));

    if (isThumbnail(options)){
        return getThumbnail(image, relativePath, options);
    }
    return image;
};

const getThumbnail = async (image:Buffer, imageRelativePath:string, options: ThumbnailConfig & Config): Promise<Buffer|ArrayBuffer> => {
    const parsed = path.parse(imageRelativePath);
    const {dir, name} = parsed;
    const ext = parsed.ext.slice(1).toLocaleLowerCase();

    const thumbnailDir = path.join(options.thumbnailDir, getSizeLabel(options), dir);
    const thumbnailPath = path.join(thumbnailDir, name)+'.jpg';
    
    // See if we already have the thumbnail
    try{
        return await readFile(thumbnailPath);
    }catch(err){
        if (!hasProperty(err, 'code') || err.code !== 'ENOENT'){
            throw err;
        }
    }

    // File doesn't exist, create it
    const handler = handlers.get(ext as any);
    if (!handler){
        throw new Error(`No handler for ${ext}`);
    }
    const thumbnail = await handler(image, {...options,...getNearestSize(options)});

    // Save the thumbnail
    await mkdir(thumbnailDir, { recursive: true });
    await sharp(thumbnail).toFile(thumbnailPath);

    return thumbnail;
};