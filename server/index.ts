import http from "node:http";
import path from "node:path";
import process from "node:process";
import { rootDir } from "./config.ts";
import { fileHandlers } from "./mediaConverters.ts";
import { mediaDatabase } from "./mediaDatabase.ts";
import { processFilesInDirectory } from "./processFiles.ts";

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
        const relativePath = pathname.substring(mediaPath.length)
            .replaceAll("/", path.sep);
        // We don't want to allow access to parent directories
        if (pathname.includes('..')){
            response.writeHead(403)
            response.end()
            return;
        }
        const fullPath = path.join(rootDir, relativePath);
        const folderRequested = relativePath.endsWith(path.sep)||relativePath === ''
        if (folderRequested){
            if (requestURL.searchParams.get("type") === "folders"){
                const folders = mediaDatabase.listSubfolders(relativePath);
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({folders}));
            } else {
                const recursive = requestURL.searchParams.get("recursive") === "true";
                const dbResults = mediaDatabase.search({ parentPath: relativePath, recursive });
                const output = dbResults.map(row => ({
                    path: `${row.parent_path}/${row.name}`,
                }));
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify(output));
            }
        }else{
            const ext = path.extname(relativePath).toLowerCase();
            const handler = fileHandlers.find(h => (h.extensions as string[]).includes(ext))?.handler;
            if (handler){
                const width = requestURL.searchParams.get('width');
                if (width && isNaN(Number(width))){
                    response.writeHead(400, {'Content-Type': 'text/plain'});
                    response.end('Invalid width parameter');
                    return;
                }
                try {
                    const result = await handler(relativePath, { width: Number(width||1024) });
                    if (result) {
                        response.writeHead(200, {'Content-Type': result.contentType});
                        response.end(result.file);
                    } else {
                        response.writeHead(404);
                        response.end();
                    }
                } catch (error) {
                    console.error(`Error handling file ${fullPath}:`, error);
                    response.writeHead(500);
                    response.end();
                }
            }else{
                response.writeHead(415); // Unsupported Media Type
                response.end();
            }
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

const startFileProcessing = async () => {
    console.log("Starting file processing...");
    try {
        let count =0;
        for await (const result of processFilesInDirectory(rootDir, rootDir, mediaDatabase)) {
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

// startFileProcessing();

