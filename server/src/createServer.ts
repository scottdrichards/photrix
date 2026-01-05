import http from "node:http";
import { IndexDatabase } from "./indexDatabase/indexDatabase.ts";
import { filesRequestHandler } from "./requestHandlers/filesRequestHandler.ts";
import { foldersRequestHandler } from "./requestHandlers/foldersRequestHandler.ts";

const PORT = process.env.PORT || 3000;

type ServerOptions = {
    onRequest: () => void;
};

export const createServer = (database: IndexDatabase, storagePath: string, options: ServerOptions) => {
    const { onRequest } = options;
    const server = http.createServer((req, res) => {
        onRequest();
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
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "ok", message: "Server is running" }));
            return;
        }

        // Get folders endpoint - list subfolders at a given path
        if (req.url?.startsWith("/api/folders/") && req.method === "GET") {
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