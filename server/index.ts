import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileHandlers } from "./mediaConverters.ts";
import { type MediaFile, scanFolder, search, root, getItem } from "./database.ts";

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

    if (pathname.startsWith(mediaPath)){
        console.log(`Requesting media path: ${pathname}`);
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

            const item = getItem(root, relativePath);
            if (item.type === 'file'){
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

            if (item.type === 'folder'){
                const {includedAttributes, includeSubfolders, ...indexSearchParams} = Object.fromEntries([...requestURL.searchParams.entries()]
                        .map(([key, value]) => {
                            try{
                                return [key, JSON.parse(value)];
                            } catch {
                                return [key, value.split(',').map(v => v.trim())];
                            }
                        }));

                const items = search({within: item, recursive:includeSubfolders??false, ...indexSearchParams});

                const specialDetailsHandlers = {
                    resolution: (item: MediaFile) => ({
                        width: item.tags?.ImageWidth,
                        height: item.tags?.ImageHeight,
                    })
                } as const satisfies Record<string, (item: MediaFile) => any>;

                response.writeHead(200, {'Content-Type': 'text/plain'});
                response.setHeader('Cache-Control', 'no-cache');
                let bufferReady = true;
                
                for (const item of items) {
                    if (!bufferReady) {
                        await new Promise(resolve => response.once('drain', resolve));
                    }
                    const pathWithHTMLSeparator = path.relative(root.parentPath, path.join(item.parentPath,item.name)).replaceAll(path.sep, '/');
                    const out = (()=>{
                        const outBase = {
                            path: pathWithHTMLSeparator,
                            type: item.type,            
                        }
                        if (includedAttributes && item.type === 'file'){
                            if (!Array.isArray(includedAttributes)){
                                throw new Error("includedAttributes must be an array");
                            }
                            const details = Object.fromEntries(
                                includedAttributes?.map(detail => {
                                        if (detail in specialDetailsHandlers){
                                            return [detail,specialDetailsHandlers[detail as keyof typeof specialDetailsHandlers](item)];
                                        }
                                        return [detail, item.tags?.[detail as keyof typeof item.tags]];
                                    })
                                    .filter(([_, detail]) => detail !== undefined)
                            );
                            if (Object.keys(details).length > 0){
                                return {...outBase, details};
                            }
                        }
                        return outBase;
                    })();
                    const lineText = JSON.stringify(out);
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
await scanFolder(root);