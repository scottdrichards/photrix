import { readdir } from 'fs/promises';
import path from 'path';
import { supportedImageExtensions } from './media/getImage';

const videoExtensions = ['mp4', 'webm', 'ogg', 'flv', 'avi', 'mov', 'wmv', 'mkv', 'm4v', 'mpg', 'mpeg', '3gp', '3g2', '.hevc'];

type GetFileListOptions = {
    recursive?: boolean, // default is false
    extensions?: string[], // default is all known images and videos

}
const defaults:Required<GetFileListOptions> = {
    recursive: false,
    extensions: [...supportedImageExtensions, ...videoExtensions],
}

export const getFileList = async (filePath:string, params:GetFileListOptions):Promise<string[]>=>{
    const {recursive, extensions} = {...defaults, ...params};

    const fileDirs = await readdir(filePath, {recursive, withFileTypes: true});
    
    return fileDirs
        .filter(f=>f.isFile())
        .filter(file=>{
            const fileExt = path.extname(file.name).split('.').at(-1)?.toLocaleLowerCase();
            return fileExt && extensions.includes(fileExt);
        })
        .map(file=>{
            return path.join(file.parentPath,file.name);
        });
};