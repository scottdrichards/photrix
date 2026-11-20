import type http from "node:http";
import { writeJson } from "../common/writeJson.ts";
import type { StoriesService } from "../stories/storiesService.ts";

/**
 * GET /api/stories       -> { stories: StorySummary[] }, newest first
 * GET /api/stories/<id>  -> StoryDetail, or 404 when no story has that id
 */
export const storiesRequestHandler = async (
  req: http.IncomingMessage & { url: string },
  res: http.ServerResponse,
  stories: StoriesService,
): Promise<void> => {
  if (req.method !== "GET") return writeJson(res, 405, { error: "Method not allowed" });
  const id = decodeURIComponent(
    new URL(req.url, "http://localhost").pathname.replace(/^\/api\/stories\/?/, ""),
  );
  if (!id) return writeJson(res, 200, { stories: await stories.list() });
  const detail = await stories.detail(id);
  return detail
    ? writeJson(res, 200, detail)
    : writeJson(res, 404, { error: "No such story" });
};
