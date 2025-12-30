import * as http from "http";
import { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { normalizeFolderPath } from "../indexDatabase/utils/pathUtils.ts";

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

    // Extract path after /api/folders/ and decode URL escape characters (empty => root)
    const pathMatch = url.pathname.match(/^\/api\/folders\/(.*)/);
    const subPath = pathMatch ? decodeURIComponent(pathMatch[1]) : "/";
    const normalizedPath = normalizeFolderPath(subPath || "/");

    console.log(`[folders] Getting folders for path: "${normalizedPath}"`);
    const folders = database.getFolders(normalizedPath);
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
