import http from "node:http";
import { FileScanner } from "./indexDatabase/fileScanner.ts";
import { IndexDatabase } from "./indexDatabase/rowFileRecordConversionFunctions.ts";
import { healthRequestHandler } from "./requestHandlers/healthRequestHandler.ts";
import { foldersRequestHandler } from "./requestHandlers/foldersRequestHandler.ts";
import { filesRequestHandler } from "./requestHandlers/filesRequestHandler.ts";
import { statusRequestHandler, statusStreamHandler } from "./requestHandlers/statusRequestHandler.ts";

const PORT = process.env.PORT || 3000;

export const createServer = (database: IndexDatabase, storagePath: string, fileScanner: FileScanner) => {
    const server = http.createServer((req, res) => {
        const requestStart = Date.now();
        console.log(`[server] ${req.method} ${req.url}`);

        // Intercept res.end to log timing
        const originalEnd = res.end.bind(res);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        res.end = function (...args: any[]) {
            const elapsed = Date.now() - requestStart;
            console.log(`[server] ${req.method} ${req.url} completed in ${elapsed}ms (status: ${res.statusCode})`);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
            return originalEnd(...args);
        } as typeof res.end;

        // Enable CORS for client
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");

        // Handle preflight requests
        if (req.method === "OPTIONS") {
            res.writeHead(200);
            res.end();
            return;
        }

        // Basic health check endpoint
        if (req.url === "/api/health" && req.method === "GET") {
            healthRequestHandler(req, res);
            return;
        }

        // Status endpoint
        if (req.url === "/api/status" && req.method === "GET") {
            statusRequestHandler(req, res, { database, fileScanner });
            return;
        }

        if (req.url === "/api/status/stream" && req.method === "GET") {
            statusStreamHandler(req, res, { database, fileScanner });
            return;
        }

        // Get folders endpoint - list subfolders at a given path
        if (req.url?.startsWith("/api/folders") && req.method === "GET") {
            foldersRequestHandler(req as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>, res, { database });
            return;
        }

        // Files endpoint - serves individual files or queries for multiple files
        // Query mode REQUIRES trailing slash: /api/files/ or /api/files/subfolder/
        // File serving has NO trailing slash: /api/files/image.jpg
        if (req.url?.startsWith("/api/files/") && req.method === "GET") {
            filesRequestHandler(req as http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>, res, {
                database,
                storageRoot: storagePath,
            });
            return;
        }

        // Default 404
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
    });
    server.listen(PORT, () => {
        console.log(`Server listening on port ${PORT}`);
        console.log(`Health check: http://localhost:${PORT}/health`);
    });
    return server;
};