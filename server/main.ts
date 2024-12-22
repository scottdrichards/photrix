import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import process from "node:process";
import heicConvert from 'npm:heic-convert';
import sharp from 'npm:sharp';
import { Buffer } from "node:buffer";

const rootDir = "//TRUENAS/Pictures and Videos READONLY";
const cacheDir = "C:/cache/media";

const port = 9615 

const mediaPath = '/media'

const webpCachePath = (relativePath:string, width?:number) => path.join(cacheDir, relativePath)+ width||""+ ".webp";

const fileHandlers = [
    {
        extensions: ['.heic', '.heif'],
        cachePath: webpCachePath,
        handler: async (relativePath:string, width?:number) => {
            const originalPath = path.join(rootDir, relativePath);
            const cachePath = webpCachePath(relativePath, width);
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
                        buffer: fileBuffer, // the HEIC file buffer
                        format: 'JPEG', // output format
                        quality: 1 // the quality of the output file
                    });
                    const webpSharp = sharp(jpegBuffer)
                        .toFormat('webp');
                    const webpBuffer =await( width ? webpSharp.resize({ width }):webpSharp).toBuffer();
                    await fs.mkdir(path.dirname(cachePath), { recursive: true });
                    await fs.writeFile(cachePath, webpBuffer);
                    return {file:webpBuffer, contentType};
                } 
                throw e;
            }
        }
    },
    {
        extensions: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff'],
        cachePath: webpCachePath,
        handler: async (relativePath:string, width?:number) => {
            const ext = path.extname(relativePath).toLowerCase();
            const fullPath = path.join(rootDir, relativePath);
            if (!width){
                const file = await fs.readFile(fullPath);
                return {file, contentType: `image/${ext.substring(1)}`};
            }
            
            const thumbnailPath = webpCachePath(relativePath, width);
            try{
                const file = await fs.readFile(thumbnailPath);
                return {file, contentType: 'image/webp'};
            } catch (e) {
                if (e && typeof e === 'object' && "code" in e && e.code === 'ENOENT') {
                    // File not found, create thumbnail using sharp
                    const file = await fs.readFile(fullPath);
                    const thumbnail = await sharp(file)
                        .resize({ width })
                        .toFormat('webp')
                        .toBuffer();
                    await fs.mkdir(path.dirname(thumbnailPath), { recursive: true });
                    await fs.writeFile(thumbnailPath, thumbnail);
                    return {file:thumbnail, contentType: 'image/webp'};
                } 
                throw e;
            };
        }
    }
] as const satisfies {
    extensions: string[];
    cachePath: (relativePath: string, width: number) => string;
    handler: (relativePath: string, width?: number) => Promise<{file:Buffer, contentType:string}>;
}[]

http.createServer(async (request, response)=> {
    
    if (!request.url){
        response.writeHead(404);
        response.end();
        return;
    }

    const requestURL = new URL(`http://${process.env.HOST ?? 'localhost'}${request.url}`);
    const pathname = decodeURIComponent(requestURL.pathname);

    if (pathname.startsWith(mediaPath)){
        try {
            const relativePath = pathname.substring(mediaPath.length);
            // We don't want to allow access to parent directories
            if (pathname.includes('..')){
                response.writeHead(403)
                response.end()
                return;
            }
            const fullPath = path.join(rootDir, relativePath);
            const stats = await fs.stat(fullPath);
    
            
            if (stats.isDirectory()){
                const items = await fs.readdir(fullPath, {recursive: false});
                response.writeHead(200, {'Content-Type': 'text/html'});
                const itemsHtml = await Promise.all( items.map(async item => {
                    const stat = await fs.stat(path.join(rootDir, relativePath, item));
                    const itemPath = path.join(mediaPath, relativePath, item);
                    if (stat.isDirectory()){
                        return `<a href="${itemPath}">${item}</a>`;
                    }

                    return `<a href="${itemPath}">
                        <img loading="lazy" src="${itemPath}?thumbnail=true" />
                    </a>`;
                })).then(items => `<ol class="thumbnails">${items.map(el=>`<li>${el}</li>`).join('')}</ol>`);
                
                const html = `
                <!DOCTYPE html>
                <html lang="en">
                    <head>
                        <link rel="stylesheet" type="text/css" href="/styles/thumbnailList.css">
                    </head>
                    <body>
                        ${itemsHtml}
                    </body>
                </html>`;
                response.write(html);
                response.end()
                return;
            };
    
            if (stats.isFile()){
                const ext = path.extname(relativePath).toLowerCase();
                const handler = fileHandlers.find(handler => (handler.extensions as string[]).includes(ext));
                if (!handler){
                    response.writeHead(415);
                    response.end();
                    return;
                }
                const isThumbnail = requestURL.searchParams.has('thumbnail');
                const {file, contentType} = await handler.handler(relativePath, isThumbnail ? 300 : undefined);
    
                response.writeHead(200, {'Content-Type': contentType});
                response.write(file);
                response.end()
                return;
            }
       } catch(e) {
            response.writeHead(500)
            response.end()     // end the response so browsers don't hang
            console.log(e)
       }     
    }

    const publicPath = path.join(import.meta.dirname??"", 'public', pathname);
    const file = await fs.readFile(publicPath).catch(() => null);
    if (file){
        response.writeHead(200);
        response.write(file);
        response.end();
    }

}).listen(port)

console.log("listening on port "+port)