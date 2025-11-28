import * as http from "http";
import { IndexDatabase } from "../indexDatabase/indexDatabase.ts";

type Options = {
  database: IndexDatabase;
};

export const foldersRequestHandler = async (
  req: http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
  res: http.ServerResponse,
  { database }: Options,
) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // Extract path after /api/folders/ and decode URL escape characters
    const pathMatch = url.pathname.match(/^\/api\/folders\/(.+)/);
    const subPath = pathMatch ? decodeURIComponent(pathMatch[1]) : "";

    // Remove trailing slash if present
    const cleanPath = subPath.endsWith("/") ? subPath.slice(0, -1) : subPath;

    console.log(`[folders] Getting folders for path: "${cleanPath}"`);
    const folders = database.getFolders(cleanPath);
    console.log(`[folders] Found ${folders.length} folders`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ folders }));
  } catch (error) {
    console.error("Error getting folders:", error);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "Internal server error",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
};
