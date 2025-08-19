import http from "node:http";
import path from "node:path";
import process from "node:process";
import { rootDir } from "./config.ts";
import { fileHandlers } from "./mediaConverters.ts";
import { mediaDatabase, numberSearchableColumns, textSearchableColumns, type MediaFileProperties, type NumberSearchableColumns, type SearchFilters } from "./mediaDatabase.ts";
import { processFilesInDirectory } from "./processFiles.ts";
import zlib from "node:zlib";

const port = 9615

const mediaPath = '/media';

export type MediaDirectoryResult = Array<{path:string, type:'directory'|'file', details?:any}>;

const getFilter = (searchParams: URLSearchParams): SearchFilters => {
    const allFields = ["name", "excludeSubfolders", "keywords", ...textSearchableColumns, ...numberSearchableColumns] as const;

    const textFilter = allFields
        .map(column => [column, searchParams.get(column)] as const)
        .filter((tuple): tuple is [typeof tuple[0], string] => tuple[1] !== null)
        .map(([column, value]) => {
            try {
                return [column, JSON.parse(value) as Exclude<SearchFilters[typeof column], undefined>] as const;
            } catch {
                return [column, value] as const ;
            }
        })
        .map(([column, value]) => {
            if (numberSearchableColumns.includes(column as NumberSearchableColumns)) {
                if (Array.isArray(value)) {
                    return [column, value.map(v => Number(v))] as const;
                }
                if (typeof value === "string") {
                    return [column, Number(value)] as const;
                }
                return [column, value] as const;
            }
            return [column, value] as const;
        })
        .reduce((acc, [column, value]) => {
            if (value) {
                return {...acc, [column]: value };
            }
            return acc;
        }, {} as SearchFilters);

    return {
        ...textFilter
    };
};

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
            } else if (requestURL.searchParams.get("type") === "column-values") {
                const column = requestURL.searchParams.get("column");
                const containsText = requestURL.searchParams.get("containsText");
                
                if (!column) {
                    response.writeHead(400, { 'Content-Type': 'text/plain' });
                    response.end('Missing column parameter');
                    return;
                }

                try {
                    const distinctValues = mediaDatabase.getColumnDistinctValues(
                        column as keyof MediaFileProperties,
                        {
                            filter: {
                                parentPath: relativePath,
                                ...getFilter(requestURL.searchParams),
                                [column]: undefined // Ensure we don't filter by the column itself
                            },
                            containsText: containsText || undefined
                        }
                    );
                    // Filter out null/undefined values
                    const filteredValues = distinctValues.filter(item => item.value !== null && item.value !== undefined);
                    response.writeHead(200, { 'Content-Type': 'application/json' });
                    response.end(JSON.stringify(filteredValues));
                } catch (error) {
                    console.error('Error getting column values:', error);
                    response.writeHead(500, { 'Content-Type': 'text/plain' });
                    response.end('Internal server error');
                }
            } else {
                const excludeSubfolders = requestURL.searchParams.get('excludeSubfolders') !== 'false';

                const filter = getFilter(requestURL.searchParams);

                const dbResults = mediaDatabase.search({ parentPath: relativePath, excludeSubfolders, ...filter });

                const output = dbResults.map(row => ({
                    path: `${row.parent_path}/${row.name}`,
                    details: requestURL.searchParams.get('details')?.split(",").map(v => v.trim()).reduce((acc, key) => {
                        switch (key) {
                            case 'aspectRatio':
                                acc.aspectRatio = row.image_width && row.image_height ? row.image_width / row.image_height : undefined;
                                break;
                            case 'geolocation':
                                acc.geolocation = row.gps_latitude && row.gps_longitude ? {
                                    latitude: row.gps_latitude,
                                    longitude: row.gps_longitude
                                } : undefined;
                                break;
                            default:
                                acc[key] = row[key as keyof typeof row];
                                break;
                        }
                        return acc;
                    }, {} as Record<string, any>)
                }));
                response.writeHead(200, { 'Content-Type': 'application/json' });
                const json = JSON.stringify(output);
                response.setHeader('Content-Encoding', 'gzip');
                response.writeHead(200, { 'Content-Type': 'application/json' });
                
                const gzip = zlib.createGzip();
                gzip.pipe(response);
                gzip.end(json);
            }
        }else{
            // Check if this is a request for file information
            if (requestURL.searchParams.get("info") === "true") {
                try {
                    const fileInfo = mediaDatabase.getFileByPath(relativePath);
                    if (fileInfo) {
                        response.writeHead(200, { 'Content-Type': 'application/json' });
                        response.end(JSON.stringify({
                            name: fileInfo.name,
                            parent_path: fileInfo.parent_path,
                            date_taken: fileInfo.date_taken,
                            date_modified: fileInfo.date_modified,
                            rating: fileInfo.rating,
                            camera_make: fileInfo.camera_make,
                            camera_model: fileInfo.camera_model,
                            lens_model: fileInfo.lens_model,
                            focal_length: fileInfo.focal_length,
                            aperture: fileInfo.aperture,
                            shutter_speed: fileInfo.shutter_speed,
                            iso: fileInfo.iso,
                            hierarchical_subject: fileInfo.hierarchical_subject,
                            image_width: fileInfo.image_width,
                            image_height: fileInfo.image_height,
                            orientation: fileInfo.orientation,
                            date_indexed: fileInfo.date_indexed,
                            keywords: fileInfo.keywords
                        }));
                    } else {
                        response.writeHead(404, { 'Content-Type': 'text/plain' });
                        response.end('File not found in database');
                    }
                } catch (error) {
                    console.error(`Error getting file info for ${relativePath}:`, error);
                    response.writeHead(500, { 'Content-Type': 'text/plain' });
                    response.end('Internal server error');
                }
                return;
            }

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
        for await (const result of processFilesInDirectory("./", rootDir, mediaDatabase)) {
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
