import type http from "node:http";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import type { FilterElement } from "../indexDatabase/indexDatabase.type.ts";
import { combineFilters } from "../auth/shareScope.ts";
import { generateShareDescription } from "../shareDescription/generateShareDescription.ts";
import { writeJson } from "../utils.ts";
import { readJsonBody } from "../common/readBody.ts";

export const pageTitleHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  database: IndexDatabase,
  shareFilter: unknown = null,
): Promise<void> => {
  let body: { filter?: FilterElement; semanticQuery?: string };
  try {
    body = await readJsonBody<typeof body>(req);
  } catch {
    writeJson(res, 400, { error: "Bad request" });
    return;
  }

  const callerFilter: FilterElement = body.filter ?? {};
  const title = await generateShareDescription({
    filter: shareFilter
      ? combineFilters([shareFilter, callerFilter])
      : callerFilter,
    semanticQuery: typeof body.semanticQuery === "string" ? body.semanticQuery : undefined,
    database,
  });

  writeJson(res, 200, { title });
};
