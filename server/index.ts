import http from "node:http";
import path from "node:path";
import process from "node:process";
import { rootDir } from "./config.ts";
import { directoryHandler } from "./handlers/directoryHandler.ts";
import { fileInfoHandler } from "./handlers/fileInfoHandler.ts";
import { staticFileHandler } from "./handlers/staticFileHandler.ts";
import { NOT_HANDLED, type MediaRequestHandler } from './handlers/types.ts';
import { mediaDatabase } from "./mediaDatabase.ts";
import { processFilesInDirectory } from "./processFiles.ts";
import { unifiedMediaHandler } from "handlers/unifiedMediaHandler.ts";

const port = 9615;

const mediaPath = '/media';

export type MediaDirectoryResult = Array<{path:string, type:'directory'|'file', details?:any}>;

// getFilter logic moved into directoryHandler.

http.createServer(async (request: http.IncomingMessage, response: http.ServerResponse)=> {
    // Set CORS headers for all requests
    response.setHeader('Access-Control-Allow-Origin', '*'); // Allow all origins
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range');
    response.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
    
    // Handle preflight OPTIONS requests
    if (request.method === 'OPTIONS') {
        response.writeHead(200);
        response.end();
        return;
    }

    if (!request.url){
        response.writeHead(404);
        response.end();
        return;
    }

    const requestURL = new URL(`http://${process.env.HOST ?? 'localhost'}${request.url}`);
    const pathname = decodeURIComponent(requestURL.pathname);

    console.info(`Request for ${pathname}`);
    if (pathname.startsWith(mediaPath)){
        const relativePath = pathname.substring(mediaPath.length).replaceAll('/', path.sep);
        if (pathname.includes('..')) {
            response.writeHead(403);
            response.end();
            return;
        }
        const fullPath = path.join(rootDir, relativePath);
        // folderRequested logic moved into directoryHandler; file metadata handled by fileInfoHandler

        // Unified handler pipeline (directoryHandler covers folder/search scenarios)
        const ctx = {
            req: request,
            res: response,
            url: requestURL,
            pathname,
            relativePath,
            fullPath,
            query: requestURL.searchParams,
            width: (() => { const widthParam = requestURL.searchParams.get('width'); const wantsThumb = requestURL.searchParams.get('thumbnailImage') === 'true'; const w = widthParam ? Number(widthParam) : (wantsThumb ? 480 : undefined); return isNaN(w as number) ? undefined : w; })(),
            wantsThumbnail: requestURL.searchParams.get('thumbnailImage') === 'true'
        } as const;
        const widthParam = requestURL.searchParams.get('width');
        if (widthParam && isNaN(Number(widthParam))){
            response.writeHead(400, { 'Content-Type': 'text/plain' });
            response.end('Invalid width parameter');
            return;
        }
        let handled = false;

        // Order is important here - first match gets to handle the request
        const handlers: MediaRequestHandler[] = [
            directoryHandler,
            fileInfoHandler,
            unifiedMediaHandler,
            staticFileHandler
        ];

        for (const handler of handlers) {
            try {
                const res = await handler(ctx);
                if (res === NOT_HANDLED) continue;
                handled = true;
                break;
            } catch (error) {
                console.error(`[HandlerPipeline] Error for ${fullPath}`, error);
                if (!response.headersSent) {
                    response.writeHead(500, { 'Content-Type': 'text/plain' });
                    response.end('Internal server error');
                }
                return;
            }
        }
        if (!handled && !response.headersSent){
            response.writeHead(404, { 'Content-Type': 'text/plain' });
            response.end('Not found');
        }
    } else {
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

const startFileProcessing = async () => {
    console.log("Starting file processing...");
    try {
        let count =0;
        for await (const result of processFilesInDirectory("./2025/01", rootDir, mediaDatabase)) {
            console.log("Processed file:", path.join(result.parent_path, result.name));
            if (count++ % 1000 === 0) {
                console.log(`Processed ${count} files`);
            }
        }
        console.log("File processing completed");
    } catch (error) {
        console.error("File processing error:", error);
    }
};

// startFileProcessing().then(()=>console.log("Finished file processing"));
