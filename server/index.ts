import fs from "fs/promises";
import http from "http";
import path from "path";
import process from "process";
import { fileHandlers } from "./mediaConverters.ts";
import { rootDir } from "./config.ts";
import { Database, type Folder } from "./database.ts";

const port = 9615 

const mediaPath = '/media';

export type MediaDirectoryResult = Array<{path:string, type:'directory'|'file', details?:any}>;

const database = new Database(rootDir);

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

    if (pathname.startsWith(mediaPath)){
        try {
            const relativePath = pathname.substring(mediaPath.length)
                .replace(/^\/+/, '') // Remove leading slashes                
                .replaceAll("/", path.sep);
            // We don't want to allow access to parent directories
            if (pathname.includes('..')){
                response.writeHead(403)
                response.end()
                return;
            }
            
            const itemAtPath = await database.getSingle(relativePath);
            if (!itemAtPath){
                response.writeHead(404);
                response.end();
                return;
            }
            if (itemAtPath.type === 'file'){
                const fileExtLowercase = path.extname(relativePath).toLocaleLowerCase();
                const fileHandler = fileHandlers.find(({extensions}) => (extensions as string[]).includes(fileExtLowercase));

                if (!fileHandler){
                    response.writeHead(415);
                    response.end();
                    return;
                }
                
                const requestedWidth = (()=>{
                    const parsed = parseInt(requestURL.searchParams.get('width') ?? '');
                    if (isNaN(parsed) || parsed < 0){
                        return undefined;
                    };
                    const sizeBreaks = [160, 320, 640, 1280] as const;
                    return sizeBreaks.find(size => parsed <= size) ?? undefined;
                })();

                const {file, contentType} = await fileHandler.handler(relativePath, {width: requestedWidth});
    
                response.writeHead(200, {'Content-Type': contentType});
                response.write(file);
                response.end()
                return;
            }

            if (itemAtPath.type === 'folder'){
                const itemGenerator = database.getMultiple({
                    within: {folder: itemAtPath, relativePath: relativePath},
                    type: requestURL.searchParams.get('type') as any,
                    search: requestURL.searchParams.get('search') ?? undefined,
                    recurse: requestURL.searchParams.get('includeSubfolders') === 'true',
                });

                response.writeHead(200, {'Content-Type': 'text/plain'});
                response.setHeader('Cache-Control', 'no-cache');
                let bufferReady = true;
                for await (const {item, relativePath} of itemGenerator){
                    if (!bufferReady) {
                        await new Promise(resolve => response.once('drain', resolve));
                    }
                    const pathWithHTMLSeparator = relativePath.replaceAll(path.sep, '/');
                    const lineText = JSON.stringify({path: pathWithHTMLSeparator, type: item.type});
                    bufferReady = response.write(lineText + "\n")
                }
                response.end()
                return;
            };
       } catch(e) {
            response.writeHead(500)
            response.end()
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