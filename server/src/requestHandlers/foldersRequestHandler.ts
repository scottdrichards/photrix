import * as http from "http";
import { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import type { FilterElement } from "../indexDatabase/indexDatabase.type.ts";
import { decodeRequestPath } from "../common/decodeRequestPath.ts";
import {
  canonicalFolderPath,
  isFolderWithinShareScope,
  type ShareFolderRoot,
} from "../auth/shareFolderScope.ts";
import { combineFilters } from "../auth/shareScope.ts";

type Options = {
  database: IndexDatabase;
  /**
   * Resolved filter of the share link this request is authenticated by, if any.
   * ANDed into the folder query so a share link can only ever see folders that
   * actually contain items it was granted — the listing itself is the boundary,
   * on top of the explicit path clamp applied by the caller.
   */
  shareFilter?: unknown;
  /** Folder boundary of the share link; null when it isn't folder-scoped. */
  shareFolderRoots?: ShareFolderRoot[] | null;
};

export const foldersRequestHandler = async (
  req: http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
  res: http.ServerResponse,
  { database, shareFilter = null, shareFolderRoots = null }: Options,
) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // Extract path after /api/folders/ and decode URL escape characters (empty => root)
    const pathMatch = url.pathname.match(/^\/api\/folders\/(.*)/);
    const subPath = pathMatch ? decodeRequestPath(pathMatch[1]) : "/";
    // Canonical form: `.`/`..` segments resolved, including percent-encoded ones
    // that survive URL parsing. Both the share clamp below and the query itself
    // then operate on a path that cannot secretly point somewhere else.
    const normalizedPath = canonicalFolderPath(subPath || "/");

    // Path clamp: a share link may browse within what was shared (and down the
    // ancestor chain leading to it), never up and out of it. Refused here, on
    // the server — the client hiding the affordance is not a boundary.
    if (shareFilter && !isFolderWithinShareScope(normalizedPath, shareFolderRoots)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden" }));
      return;
    }

    const filterParam = url.searchParams.get("filter");
    const requestFilter = filterParam ? (JSON.parse(filterParam) as FilterElement) : {};
    const filter = combineFilters([
      requestFilter,
      ...(shareFilter ? [shareFilter as FilterElement] : []),
    ]);
    const folders = await (() => database.getFolders(normalizedPath, filter))();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ folders }));
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "Internal server error",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
};
