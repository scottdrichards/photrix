import fs from "fs/promises";
import http from "http";
import path from "path";
import process from "process";
import { fileHandlers } from "./mediaConverters.ts";
import { rootDir } from "./config.ts";
// import { database, type Folder } from "./database.ts";

const port = 9615 

const mediaPath = '/media';

export type MediaDirectoryResult = Array<{path:string, type:'directory'|'file', details?:any}>;

http.createServer(async (request, response)=> {
    response.setHeader('Access-Control-Allow-Origin', "http://127.0.0.1:5173");
    response.setHeader('Access-Control-Allow-Origin', "http://localhost:5173");
    response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (!request.url){
        response.writeHead(404);
        response.end();
        return;
    }

    const requestURL = new URL(`http://${process.env.HOST ?? 'localhost'}${request.url}`);
    const pathname = decodeURIComponent(requestURL.pathname);

    console.log(pathname)

    // if (pathname === '/allFileNames'){
    //     response.writeHead(200, { 'Content-Type': 'text/plain' });
    //     const walkFolder = async (folder:Folder, currentPath:string) => {
    //         for (const item of folder.children){
    //             if ('children' in item){
    //                 await walkFolder(item, currentPath+"/"+folder.name);
    //             } else {
    //                 response.write(currentPath+"/"+item.name);
    //             }
    //         }
    //     };
        
    //     await walkFolder(database.root, "");
    //     response.end();
    //     return;
    // }

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
                type Result = {path:string, type:'directory'|'file'};
                const recursive = requestURL.searchParams.get('includeSubfolders') === 'true';
                const searchString = requestURL.searchParams.get('search') || "";
                const detailsWanted = JSON.parse(requestURL.searchParams.get('details')||"[]") as unknown[];
                const items = await fs.readdir(fullPath, {recursive});
                response.writeHead(200, {'Content-Type': 'text/json'});
                for (const item of items){
                    const itemPath = path.posix.join(relativePath, item);
                    if (searchString && !itemPath.toLowerCase().includes(searchString.toLowerCase())){
                        continue;
                    }
                    const stat = await fs.stat(path.join(rootDir, relativePath, item));
                    
                    if (stat.isDirectory()){
                        console.log("sending: ", item)
                    } 
                    if (requestURL.searchParams.get('excludeFolders') === 'true' && stat.isDirectory()){
                        continue
                    }
                    const localFileHandler = fileHandlers.find(handler => (handler.extensions as string[]).includes(path.extname(itemPath)));
                    const details = localFileHandler && "details" in localFileHandler && await localFileHandler.details(itemPath, detailsWanted as any);
                    const lineText = JSON.stringify({path: itemPath, type: stat.isDirectory() ? 'directory' : 'file', ...(details?{details}:{})});
                    await new Promise(resolve => {
                    response.write(lineText + "\n", resolve)});
                }
                response.end()
                return;
            };
    
            if (stats.isFile()){
                const fileExtLowercase = path.extname(relativePath).toLocaleLowerCase();
                const fileHandler = fileHandlers.find(({extensions}) => (extensions as string[]).includes(fileExtLowercase));

                if (!fileHandler){
                    response.writeHead(415);
                    response.end();
                    return;
                }
                
                const width = (()=>{
                    const widthRequested = requestURL.searchParams.get('width');
                    if (!widthRequested) return undefined;
                    const parsed = parseInt(widthRequested);
                    if (isNaN(parsed) || parsed < 0){
                        return undefined;
                    };
                    const sizeBreaks = [160, 320, 640, 1280] as const;
                    return sizeBreaks.find(size => parsed <= size) ?? undefined;
                })();

                const {file, contentType} = await fileHandler.handler(relativePath, {width});
    
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
    }else{
        const forwardOptions = {
            hostname: "localhost",
            port: 5173,
            path: request.url,
            method: request.method,
            headers: request.headers,
        };
        const forwardReq = http.request(forwardOptions, (forwardRes) => {
            response.writeHead(forwardRes.statusCode ?? 500, forwardRes.headers);
            forwardRes.pipe(response, { end: true });
        });
        request.pipe(forwardReq, { end: true });
    }

}).listen(port)

console.log("listening on port "+port)